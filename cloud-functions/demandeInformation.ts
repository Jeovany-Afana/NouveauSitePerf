/**
 * ────────────────────────────────────────────────────────────────────────
 *  demandeInformation.ts
 *  HTTP Cloud Function pour le formulaire "Demande d'information"
 *  de la page contact.html de Performics.
 *
 *  Effets de bord :
 *    1. Crée un document `demandes_information` (historique brut de la demande)
 *    2. Crée un document `prospects` rattaché à l'année académique courante
 *       (compatible avec `ProspectCreate.vue` de la plateforme admin),
 *       avec détection NON bloquante de doublons par téléphone / email.
 *    3. Envoie un email de confirmation au visiteur (si email fourni)
 *    4. Envoie un email de notification à l'équipe admissions
 *
 *  ➤ Déploiement :
 *      - Copier ce fichier dans `functions/src/`.
 *      - Réexporter depuis `index.ts` :
 *            export { demandeInformation } from "./demandeInformation";
 *      - Ajouter les `case` INFO_REQUEST_RECEIVED / INFO_REQUEST_ADMIN dans
 *        `buildEmailFromType` (cf. bloc tout en bas de ce fichier).
 *      - Déployer :
 *            firebase deploy --only functions:demandeInformation
 *
 *  URL de production attendue :
 *      https://us-central1-performics-92bb0.cloudfunctions.net/demandeInformation
 * ────────────────────────────────────────────────────────────────────────
 */

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import "./admin";

/* ───────────────────── Config ───────────────────── */

// Adresse qui reçoit la notification côté équipe Performics.
const ADMIN_EMAIL = "contact@performics-group.sn";

/* ──────────────── Validation helpers ──────────────── */

const nameRE  = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]{2,40}$/;
const telRE   = /^(?:\+221\s?|0)?7[0-9]{8}$/;
const emailRE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_SEXES = new Set<string>(["Homme", "Femme"]);

/**
 * Liste blanche des programmes acceptés.
 * DOIT rester alignée avec le <select> de contact.html.
 * Toute valeur qui n'est pas ici est rejetée côté serveur.
 */
const VALID_PROGRAMMES = new Set<string>([
  // Business School — Licence
  "Licence Gestion des entreprises",
  "Licence QHSE",
  "Licence Agrobusiness",
  "Licence Management du Sport",
  // Business School — Master
  "Master Supply Chain Management",
  "Master Ingénierie Financière",
  // École d'ingénieurs — Licence
  "Génie Civil",
  "Génie Electromécanique",
  "Génie Informatique",
  "Géomatique",
  // École d'ingénieurs — Master
  "Intelligence Artificielle & Ingénierie Logicielle",
  // BTS Tertiaire / Commerce
  "BTS Transport/Logistique",
  "BTS Transit",
  "BTS Comptabilité Gestion",
  "BTS Marketing",
  "BTS Assistant de Gestion PME/PMI",
  "BTS Commerce International",
  "BTS Secrétariat Bureautique",
  // BTS Technique
  "BTS Informatique de gestion",
  "BTS Génie Civil",
  "BTS Géomatique",
  // Formations Certifiantes (CPS)
  "CPS Développeur Web",
  "CPS Support Informatique",
  "CPS Infographie Maquettiste",
  "CPS Marketing Digital",
  "CPS Assistant Qualité (QHSE)",
  "CPS Producteur Horticole",
  "CPS Agent Technique de Transformation fruits et légumes",
  "Opérateur Vidéos",
  "CPS Opérateur Topographe",
  "CPS Agent Immobilier",
  "Administrateur de Réseaux Locaux d'Entreprise",
  // Certificats
  "Assistanat de Direction",
  "Agrobusiness & Entrepreneuriat Agricole",
  "Bureautique",
  // Anglais
  "Anglais Général",
  "Anglais des Affaires",
  "Anglais de Spécialité",
  "Anglais Académique",
]);

type Payload = {
  prenom: string;
  nom: string;
  sexe: string;
  adresse: string;
  email?: string;
  telephone: string;
  classe: string;
  etablissement: string;
  programme: string;
};

/* ──────────────── Utilitaires ──────────────── */

/**
 * Normalise un numéro sénégalais en format E.164 : +221XXXXXXXXX.
 * Accepte +221770000000, +221 770000000, 0770000000, 770000000.
 */
function normalizePhone(raw: string): string {
  const digits = String(raw || "").replace(/\D+/g, "");
  // Garde les 9 derniers chiffres (n° local 7XXXXXXXX) puis préfixe +221.
  const local = digits.slice(-9);
  return `+221${local}`;
}

/**
 * Récupère l'id de l'année académique courante (`is_current === true`).
 * Fallback : la plus récente par libellé.
 */
async function getCurrentYearId(db: FirebaseFirestore.Firestore): Promise<string | null> {
  const cur = await db
    .collection("annee_academique")
    .where("is_current", "==", true)
    .limit(1)
    .get();
  if (!cur.empty) return cur.docs[0].id;

  const all = await db.collection("annee_academique").get();
  if (all.empty) return null;
  const sorted = all.docs
    .map((d) => ({ id: d.id, libelle: String(d.get("libelle") || d.id) }))
    .sort((a, b) => b.libelle.localeCompare(a.libelle));
  return sorted[0].id;
}

/**
 * Cherche l'id du programme dans `programmes` en matchant `libelle` ou `nom`
 * (insensible à la casse) et limité à l'année académique fournie.
 * Retourne null si aucun match (le `programme_label` brut sera alors stocké).
 */
async function findProgrammeId(
  db: FirebaseFirestore.Firestore,
  yearId: string,
  label: string
): Promise<string | null> {
  const target = label.trim().toLowerCase();
  const docsById = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();

  // Égalité (champ scalaire annee_academique_id)
  try {
    const s = await db
      .collection("programmes")
      .where("annee_academique_id", "==", yearId)
      .get();
    s.docs.forEach((d) => docsById.set(d.id, d));
  } catch (_) { /* champ peut-être array — on tente l'autre forme */ }

  // Tableau (annee_academique_id: string[])
  try {
    const s2 = await db
      .collection("programmes")
      .where("annee_academique_id", "array-contains", yearId)
      .get();
    s2.docs.forEach((d) => docsById.set(d.id, d));
  } catch (_) { /* ignore */ }

  for (const d of docsById.values()) {
    const lib = String(d.get("libelle") || d.get("nom") || "").trim().toLowerCase();
    if (lib === target) return d.id;
  }
  return null;
}

/**
 * Renvoie les ids de prospects existants pour `yearId` partageant
 * le même téléphone OU email. Non bloquant : sert à tagger le nouveau
 * prospect afin que l'équipe puisse arbitrer/fusionner depuis la plateforme.
 */
async function findDuplicateProspects(
  db: FirebaseFirestore.Firestore,
  yearId: string,
  telephoneE164: string,
  email: string | null
): Promise<string[]> {
  const ids = new Set<string>();
  const tasks: Promise<FirebaseFirestore.QuerySnapshot>[] = [];
  if (telephoneE164) {
    tasks.push(
      db.collection("prospects")
        .where("year_id", "==", yearId)
        .where("telephone", "==", telephoneE164)
        .get()
    );
  }
  if (email) {
    tasks.push(
      db.collection("prospects")
        .where("year_id", "==", yearId)
        .where("email", "==", email)
        .get()
    );
  }
  if (!tasks.length) return [];
  const snaps = await Promise.all(tasks);
  snaps.forEach((s) => s.docs.forEach((d) => ids.add(d.id)));
  return Array.from(ids);
}

/* ───────────────────── Handler ───────────────────── */

export const demandeInformation = onRequest(
  {
    region: "us-central1",
    cors: true,
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      const body = (req.body || {}) as Partial<Payload>;

      // Sanitisation — on trim tout et on borne la longueur pour éviter les abus.
      const prenom        = String(body.prenom        ?? "").trim().slice(0, 80);
      const nom           = String(body.nom           ?? "").trim().slice(0, 80);
      const sexe          = String(body.sexe          ?? "").trim().slice(0, 10);
      const adresse       = String(body.adresse       ?? "").trim().slice(0, 200);
      const email         = String(body.email         ?? "").trim().toLowerCase().slice(0, 150);
      const telephone     = String(body.telephone     ?? "").trim().slice(0, 30);
      const classe        = String(body.classe        ?? "").trim().slice(0, 60);
      const etablissement = String(body.etablissement ?? "").trim().slice(0, 150);
      const programme     = String(body.programme     ?? "").trim();

      // Validations (mêmes règles que côté client — garde-fou serveur).
      if (!nameRE.test(prenom))              { res.status(400).send("Prénom invalide."); return; }
      if (!nameRE.test(nom))                 { res.status(400).send("Nom invalide."); return; }
      if (!VALID_SEXES.has(sexe))            { res.status(400).send("Sexe invalide."); return; }
      if (adresse.length < 3)                { res.status(400).send("Adresse trop courte."); return; }
      if (!telRE.test(telephone))            { res.status(400).send("Téléphone invalide."); return; }
      if (email && !emailRE.test(email))     { res.status(400).send("Email invalide."); return; }
      if (etablissement.length < 2)          { res.status(400).send("Établissement requis."); return; }
      if (classe.length < 1)                 { res.status(400).send("Classe requise."); return; }
      if (!VALID_PROGRAMMES.has(programme))  { res.status(400).send("Programme invalide."); return; }

      const db = getFirestore();
      const phoneE164 = normalizePhone(telephone);
      const emailNorm: string | null = email || null;

      // 1) Persistance brute de la demande.
      const docRef = await db.collection("demandes_information").add({
        prenom,
        nom,
        sexe,
        adresse,
        email: emailNorm,
        telephone,
        telephone_e164: phoneE164,
        classe,
        etablissement,
        programme,
        status: "nouveau",
        source: "contact.html",
        ip: (req.headers["x-forwarded-for"] as string) || req.ip || null,
        userAgent: req.headers["user-agent"] || null,
        createdAt: FieldValue.serverTimestamp(),
      });
      const requestId = docRef.id;

      // 2) Création du prospect (compatible plateforme admin / ProspectCreate.vue).
      //    On NE bloque PAS la demande si cette étape échoue : la demande
      //    est déjà persistée et les emails partiront quand même.
      let prospectId: string | null = null;
      let potentialDuplicates: string[] = [];
      try {
        const yearId = await getCurrentYearId(db);
        if (!yearId) {
          console.warn("demandeInformation: aucune année académique trouvée — prospect non créé.");
        } else {
          const programmeId = await findProgrammeId(db, yearId, programme);
          potentialDuplicates = await findDuplicateProspects(db, yearId, phoneE164, emailNorm);

          const prospectRef = await db.collection("prospects").add({
            // ── référentiel
            year_id: yearId,

            // ── identité
            prenom,
            nom,
            sexe,

            // ── contacts
            adresse: adresse || null,
            telephone: phoneE164,
            email: emailNorm,

            // ── formation : on rattache à un programme connu si possible,
            //    sinon on conserve l'intitulé brut côté `programme_custom_label`.
            programme_id: programmeId,
            programme_label: programme,
            programme_custom_label: programmeId ? null : programme,

            // ── niveau : le visiteur ne précise que sa classe actuelle
            //    (Terminale, BAC+2…). L'équipe le complétera au besoin.
            niveau: null,
            niveau_souhaite: null,
            niveau_actuel: classe || null,

            // ── champ propre au formulaire QR
            etablissement_actuel: etablissement || null,

            // ── découverte : non demandée sur le formulaire QR public
            discover_sources: ["QR Code / Site web"],

            // ── statut + horodatages (mêmes clés que ProspectCreate.vue)
            statut: "prospect",
            created_at: FieldValue.serverTimestamp(),
            contacted_at: null,
            pre_registered_at: null,
            enrolled_at: null,

            // ── meta / attribution (mêmes clés que ProspectCreate.vue)
            stage_history: [],
            programme_at_pre: null,
            programme_at_enroll: null,
            channel_at_enroll: null,
            tags: [],
            created_by: null,           // créé par le formulaire public
            source: "qr_contact",
            channel: "online",

            // ── doublons potentiels (non bloquant — l'équipe arbitre)
            potential_duplicate_ids: potentialDuplicates,
            is_potential_duplicate: potentialDuplicates.length > 0,

            // ── lien vers la demande d'origine
            from_demande_id: requestId,
          });
          prospectId = prospectRef.id;

          // backlink demande → prospect
          await docRef.update({ prospect_id: prospectId });
        }
      } catch (e) {
        console.error("demandeInformation: échec création prospect (non bloquant):", e);
      }

      // 3) Email de confirmation au visiteur (si email fourni).
      if (emailNorm) {
        const notifyKeyUser = ["INFO_REQUEST_RECEIVED", requestId].join("__");
        await db.collection("mail_queue").add({
          to: emailNorm,
          type: "INFO_REQUEST_RECEIVED",
          locale: "fr",
          data: {
            prenom,
            nom,
            programme,
            request_id: requestId,
          },
          createdAt: FieldValue.serverTimestamp(),
          meta: { notifyKey: notifyKeyUser, requestId },
        });
      }

      // 4) Email de notification à l'équipe admissions.
      const notifyKeyAdmin = ["INFO_REQUEST_ADMIN", requestId].join("__");
      await db.collection("mail_queue").add({
        to: ADMIN_EMAIL,
        type: "INFO_REQUEST_ADMIN",
        locale: "fr",
        data: {
          prenom,
          nom,
          sexe,
          adresse,
          email: emailNorm || "—",
          telephone: phoneE164,
          classe,
          etablissement,
          programme,
          request_id: requestId,
          prospect_id: prospectId,
          duplicate_count: potentialDuplicates.length,
          link: `https://performics.netlify.app/dashboard/demandes-information/${requestId}`,
          prospect_link: prospectId
            ? `https://performics.netlify.app/dashboard/prospects/${prospectId}`
            : null,
        },
        createdAt: FieldValue.serverTimestamp(),
        meta: { notifyKey: notifyKeyAdmin, requestId },
      });

      res.status(200).json({
        ok: true,
        id: requestId,
        prospect_id: prospectId,
        potential_duplicates: potentialDuplicates,
      });
    } catch (err: any) {
      console.error("demandeInformation error:", err);
      res.status(500).send(err?.message || "Erreur serveur");
    }
  }
);


/* ════════════════════════════════════════════════════════════════════════
 *  À AJOUTER dans ta fonction `buildEmailFromType(...)` du fichier principal
 *  (celui qui exporte aussi sendEmailOnQueue). Deux nouveaux `case` à coller
 *  AVANT le `default:` final.
 *
 *  Ces templates utilisent `baseTemplate()` et `escapeHtml()` qui existent
 *  déjà dans ton fichier.
 * ════════════════════════════════════════════════════════════════════════

    // ------------------ DEMANDE D'INFORMATION ------------------
    case "INFO_REQUEST_RECEIVED": {
      // Confirmation envoyée au visiteur qui a soumis le formulaire.
      const subject = "✅ Votre demande d'information a bien été reçue";

      const prenom    = data.prenom ?? "";
      const programme = data.programme ?? "";

      return {
        subject,
        html: baseTemplate({
          title: subject,
          greeting: `Bonjour ${escapeHtml(prenom)},`,
          lines: [
            "Nous avons bien reçu votre demande d'information ✅",
            programme ? `<b>Programme souhaité :</b> ${escapeHtml(programme)}` : "",
            "Un membre de notre équipe admissions vous recontactera très rapidement pour répondre à toutes vos questions.",
            `<span style="color:#666;">En attendant, n'hésitez pas à consulter notre site ou à nous écrire à <a href="mailto:contact@performics-group.sn">contact@performics-group.sn</a>.</span>`,
          ],
          cta: {
            label: "Découvrir nos programmes",
            link: "https://performics-group.sn/bachelor-of-science-in-business-administration.html",
          },
        }),
        categories: [type, "info-request", "prospect"],
      };
    }

    case "INFO_REQUEST_ADMIN": {
      // Notification envoyée à l'équipe admissions / contact interne.
      const subject = "🆕 Nouvelle demande d'information";

      const prenom         = data.prenom ?? "";
      const nom            = data.nom ?? "";
      const sexe           = data.sexe ?? "";
      const adresse        = data.adresse ?? "";
      const email          = data.email ?? "";
      const telephone      = data.telephone ?? "";
      const classe         = data.classe ?? "";
      const etablissement  = data.etablissement ?? "";
      const programme      = data.programme ?? "";
      const requestId      = data.request_id ?? "";
      const prospectId     = data.prospect_id ?? "";
      const duplicateCount = Number(data.duplicate_count ?? 0);
      const link           = data.link ?? "";
      const prospectLink   = data.prospect_link ?? "";

      const dupBadge = duplicateCount > 0
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#fff7ed;color:#c2410c;font-size:12px;">⚠ ${duplicateCount} doublon(s) potentiel(s)</span>`
        : "";

      return {
        subject,
        html: baseTemplate({
          title: subject,
          greeting: "Bonjour,",
          lines: [
            "Une nouvelle demande d'information vient d'être soumise depuis le site.",
            `<b>Nom :</b> ${escapeHtml(`${prenom} ${nom}`.trim())}`,
            sexe          ? `<b>Sexe :</b> ${escapeHtml(sexe)}`           : "",
            telephone     ? `<b>Téléphone :</b> ${escapeHtml(telephone)}` : "",
            email         ? `<b>Email :</b> ${escapeHtml(email)}`         : "",
            adresse       ? `<b>Adresse :</b> ${escapeHtml(adresse)}`     : "",
            etablissement ? `<b>Établissement :</b> ${escapeHtml(etablissement)}` : "",
            classe        ? `<b>Classe :</b> ${escapeHtml(classe)}`       : "",
            programme     ? `<b>Programme demandé :</b> ${escapeHtml(programme)}` : "",
            prospectId    ? `<b>Prospect créé :</b> <code>${escapeHtml(prospectId)}</code> ${dupBadge}` : "",
            requestId     ? `<span style="color:#666;">ID demande : ${escapeHtml(requestId)}</span>` : "",
          ],
          cta: prospectLink
            ? { label: "Ouvrir le prospect", link: prospectLink }
            : (link ? { label: "Ouvrir la demande", link } : undefined),
        }),
        categories: [type, "info-request", "admin"],
      };
    }

 * ════════════════════════════════════════════════════════════════════════ */
