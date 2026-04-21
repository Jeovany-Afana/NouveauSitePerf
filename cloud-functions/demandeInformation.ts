/**
 * ────────────────────────────────────────────────────────────────────────
 *  demandeInformation.ts
 *  HTTP Cloud Function pour le formulaire "Demande d'information"
 *  de la page contact.html de Performics.
 *
 *  ➤ Déploiement :
 *      - Copier ce fichier dans ton dossier `functions/src/` (projet Firebase).
 *      - Réexporter la fonction depuis ton `index.ts` :
 *            export { demandeInformation } from "./demandeInformation";
 *      - Ajouter les deux `case` (INFO_REQUEST_RECEIVED / INFO_REQUEST_ADMIN)
 *        dans ta fonction `buildEmailFromType` (voir section tout en bas).
 *      - Déployer :
 *            firebase deploy --only functions:demandeInformation
 *
 *  URL de production attendue :
 *      https://us-central1-performics-92bb0.cloudfunctions.net/demandeInformation
 *  (c'est celle que le frontend appelle dans contact.html)
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
  adresse: string;
  email?: string;
  telephone: string;
  classe: string;
  etablissement: string;
  programme: string;
};

/* ───────────────────── Handler ───────────────────── */

export const demandeInformation = onRequest(
  {
    region: "us-central1",
    cors: true,
    // Limite de requêtes en parallèle — un formulaire public n'a pas besoin de plus.
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
      const adresse       = String(body.adresse       ?? "").trim().slice(0, 200);
      const email         = String(body.email         ?? "").trim().toLowerCase().slice(0, 150);
      const telephone     = String(body.telephone     ?? "").trim().slice(0, 30);
      const classe        = String(body.classe        ?? "").trim().slice(0, 60);
      const etablissement = String(body.etablissement ?? "").trim().slice(0, 150);
      const programme     = String(body.programme     ?? "").trim();

      // Validations (mêmes règles que côté client — garde-fou serveur).
      if (!nameRE.test(prenom))              { res.status(400).send("Prénom invalide."); return; }
      if (!nameRE.test(nom))                 { res.status(400).send("Nom invalide."); return; }
      if (adresse.length < 3)                { res.status(400).send("Adresse trop courte."); return; }
      if (!telRE.test(telephone))            { res.status(400).send("Téléphone invalide."); return; }
      if (email && !emailRE.test(email))     { res.status(400).send("Email invalide."); return; }
      if (etablissement.length < 2)          { res.status(400).send("Établissement requis."); return; }
      if (classe.length < 1)                 { res.status(400).send("Classe requise."); return; }
      if (!VALID_PROGRAMMES.has(programme))  { res.status(400).send("Programme invalide."); return; }

      const db = getFirestore();

      // 1) Persistance de la demande.
      const docRef = await db.collection("demandes_information").add({
        prenom,
        nom,
        adresse,
        email: email || null,
        telephone,
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

      // 2) Email de confirmation au visiteur (si email fourni).
      if (email) {
        const notifyKeyUser = ["INFO_REQUEST_RECEIVED", requestId].join("__");
        await db.collection("mail_queue").add({
          to: email,
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

      // 3) Email de notification à l'équipe admissions.
      const notifyKeyAdmin = ["INFO_REQUEST_ADMIN", requestId].join("__");
      await db.collection("mail_queue").add({
        to: ADMIN_EMAIL,
        type: "INFO_REQUEST_ADMIN",
        locale: "fr",
        data: {
          prenom,
          nom,
          adresse,
          email: email || "—",
          telephone,
          classe,
          etablissement,
          programme,
          request_id: requestId,
          // Lien direct vers le doc Firestore dans ta plateforme (adapte la route).
          link: `https://performics.netlify.app/dashboard/demandes-information/${requestId}`,
        },
        createdAt: FieldValue.serverTimestamp(),
        meta: { notifyKey: notifyKeyAdmin, requestId },
      });

      res.status(200).json({ ok: true, id: requestId });
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

      const prenom        = data.prenom ?? "";
      const nom           = data.nom ?? "";
      const adresse       = data.adresse ?? "";
      const email         = data.email ?? "";
      const telephone     = data.telephone ?? "";
      const classe        = data.classe ?? "";
      const etablissement = data.etablissement ?? "";
      const programme     = data.programme ?? "";
      const requestId     = data.request_id ?? "";
      const link          = data.link ?? "";

      return {
        subject,
        html: baseTemplate({
          title: subject,
          greeting: "Bonjour,",
          lines: [
            "Une nouvelle demande d'information vient d'être soumise depuis le site.",
            `<b>Nom :</b> ${escapeHtml(`${prenom} ${nom}`.trim())}`,
            telephone     ? `<b>Téléphone :</b> ${escapeHtml(telephone)}` : "",
            email         ? `<b>Email :</b> ${escapeHtml(email)}`         : "",
            adresse       ? `<b>Adresse :</b> ${escapeHtml(adresse)}`     : "",
            etablissement ? `<b>Établissement :</b> ${escapeHtml(etablissement)}` : "",
            classe        ? `<b>Classe :</b> ${escapeHtml(classe)}`       : "",
            programme     ? `<b>Programme demandé :</b> ${escapeHtml(programme)}` : "",
            requestId     ? `<span style="color:#666;">ID : ${escapeHtml(requestId)}</span>` : "",
          ],
          cta: link ? { label: "Ouvrir la demande", link } : undefined,
        }),
        categories: [type, "info-request", "admin"],
      };
    }

 * ════════════════════════════════════════════════════════════════════════ */
