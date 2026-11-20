// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, action messages, the "Test the connection"
// report. Four languages, the four of the Gladys interface; German says
// "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, OPERATIONS } from './incus/client.js';

export const LANGUAGE_FALLBACK = 'en';
const LANGS = ['en', 'fr', 'de', 'es'];

/** The text of a multi-language object in a language, English otherwise. */
export const pick = (text, language) => text?.[language] ?? text?.[LANGUAGE_FALLBACK] ?? '';

/** "name: text", with the French space before the colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;

/** Every language of a text built by `render(language)`. */
export const allLanguages = (render) =>
  Object.fromEntries(LANGS.map((language) => [language, render(language)]));

/**
 * A failure shown in red by Gladys: the handler throws it, its message is the
 * multi-language object (a returned value is shown in green, as a success).
 */
export class ActionFailure extends Error {
  constructor(text) {
    super(text.en);
    this.message = text;
  }
}

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Configuration problems (src/config.js `problems`, plus the missing address).
export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of the Incus server in the configuration.',
    fr: "Saisissez l'adresse du serveur Incus dans la configuration.",
    de: 'Gib die Adresse des Incus-Servers in der Konfiguration ein.',
    es: 'Introduzca la dirección del servidor Incus en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. 192.168.1.30 or https://server.lan:8443',
    fr: 'Adresse incomprise, ex. 192.168.1.30 ou https://serveur.lan:8443',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.30 oder https://server.lan:8443',
    es: 'Dirección no válida, p. ej. 192.168.1.30 o https://servidor.lan:8443',
  },
  invalidToken: {
    en: 'Trust token not understood: copy the whole line given by incus config trust add.',
    fr: 'Jeton de confiance incompris : copiez toute la ligne donnée par incus config trust add.',
    de: 'Vertrauens-Token nicht verstanden: Kopiere die ganze Zeile von incus config trust add.',
    es: 'Token de confianza no válido: copie toda la línea que da incus config trust add.',
  },
};

// One short explanation per error kind (src/incus/errors.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'the Incus server does not answer',
    fr: 'le serveur Incus ne répond pas',
    de: 'der Incus-Server antwortet nicht',
    es: 'el servidor Incus no responde',
  },
  [ERROR_KINDS.NOT_INCUS]: {
    en: 'no Incus or LXD API at this address',
    fr: 'aucune API Incus ou LXD à cette adresse',
    de: 'keine Incus- oder LXD-API unter dieser Adresse',
    es: 'no hay ninguna API de Incus o LXD en esta dirección',
  },
  [ERROR_KINDS.UNTRUSTED]: {
    en: 'Gladys is not trusted yet: paste a token of incus config trust add',
    fr: "Gladys n'est pas encore autorisé : collez un jeton de incus config trust add",
    de: 'Gladys ist noch nicht autorisiert: Füge ein Token von incus config trust add ein',
    es: 'Gladys aún no está autorizado: pegue un token de incus config trust add',
  },
  [ERROR_KINDS.TOKEN_REFUSED]: {
    en: 'trust token refused (expired or already used): create a new one',
    fr: 'jeton de confiance refusé (expiré ou déjà utilisé) : créez-en un nouveau',
    de: 'Vertrauens-Token abgelehnt (abgelaufen oder schon benutzt): Erstelle ein neues',
    es: 'token de confianza rechazado (caducado o ya usado): cree uno nuevo',
  },
  [ERROR_KINDS.CERT_CHANGED]: {
    en: 'the server certificate changed: check, then use "Trust the server certificate again"',
    fr: 'le certificat du serveur a changé : vérifiez, puis « Faire de nouveau confiance au certificat »',
    de: 'das Server-Zertifikat hat sich geändert: Prüfe es, dann „Dem Server-Zertifikat erneut vertrauen“',
    es: 'el certificado del servidor ha cambiado: compruébelo y use «Volver a confiar en el certificado»',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'Incus refused: the certificate of Gladys is restricted',
    fr: 'Incus a refusé : le certificat de Gladys est restreint',
    de: 'Incus hat abgelehnt: Das Zertifikat von Gladys ist eingeschränkt',
    es: 'Incus lo ha rechazado: el certificado de Gladys está restringido',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'no instance of that name on this server',
    fr: 'aucune instance de ce nom sur ce serveur',
    de: 'keine Instanz mit diesem Namen auf diesem Server',
    es: 'ninguna instancia con ese nombre en este servidor',
  },
  [ERROR_KINDS.REFUSED]: {
    en: 'Incus refused',
    fr: 'Incus a refusé',
    de: 'Incus hat abgelehnt',
    es: 'Incus lo ha rechazado',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

/** An error of a kind, in a language. */
export const errorText = (error, language) =>
  pick(ERROR_TEXT[error?.kind] ?? ERROR_TEXT[ERROR_KINDS.HTTP], language);

export const ACTION_TEXT = {
  notConfigured: {
    en: 'The integration is not configured yet.',
    fr: "L'intégration n'est pas encore configurée.",
    de: 'Die Integration ist noch nicht konfiguriert.',
    es: 'La integración aún no está configurada.',
  },
  noInstance: {
    en: 'Choose an instance.',
    fr: 'Choisissez une instance.',
    de: 'Wähle eine Instanz.',
    es: 'Elija una instancia.',
  },
  unknownInstance: {
    en: 'This instance no longer exists on the Incus server.',
    fr: "Cette instance n'existe plus sur le serveur Incus.",
    de: 'Diese Instanz existiert auf dem Incus-Server nicht mehr.',
    es: 'Esta instancia ya no existe en el servidor Incus.',
  },
  unknownAction: {
    en: 'Unknown action: reload the dashboard.',
    fr: 'Action inconnue : rechargez le tableau de bord.',
    de: 'Unbekannte Aktion: Lade das Dashboard neu.',
    es: 'Acción desconocida: vuelva a cargar el panel.',
  },
  unreadable: {
    en: 'Incus cannot be read right now',
    fr: 'Incus est illisible pour le moment',
    de: 'Incus kann gerade nicht gelesen werden',
    es: 'No se puede leer Incus en este momento',
  },
  pinReset: {
    en: 'The next certificate presented by the server will be trusted.',
    fr: 'Le prochain certificat présenté par le serveur sera accepté.',
    de: 'Dem nächsten Zertifikat des Servers wird vertraut.',
    es: 'Se aceptará el próximo certificado que presente el servidor.',
  },
};

// The result of an operation on a container, `name` inserted.
export const OPERATION_TEXT = {
  en: {
    [OPERATIONS.START]: { done: 'started', already: 'already running' },
    [OPERATIONS.STOP]: { done: 'stopped', already: 'already stopped' },
    [OPERATIONS.RESTART]: { done: 'restarted', already: 'started' },
    failed: 'failed',
  },
  fr: {
    [OPERATIONS.START]: { done: 'démarrée', already: 'déjà en marche' },
    [OPERATIONS.STOP]: { done: 'arrêtée', already: 'déjà arrêtée' },
    [OPERATIONS.RESTART]: { done: 'redémarrée', already: 'démarrée' },
    failed: 'échec',
  },
  de: {
    [OPERATIONS.START]: { done: 'gestartet', already: 'läuft bereits' },
    [OPERATIONS.STOP]: { done: 'gestoppt', already: 'bereits gestoppt' },
    [OPERATIONS.RESTART]: { done: 'neu gestartet', already: 'gestartet' },
    failed: 'fehlgeschlagen',
  },
  es: {
    [OPERATIONS.START]: { done: 'iniciada', already: 'ya en marcha' },
    [OPERATIONS.STOP]: { done: 'detenida', already: 'ya detenida' },
    [OPERATIONS.RESTART]: { done: 'reiniciada', already: 'iniciada' },
    failed: 'error',
  },
};

// "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: 'connected',
    instances: (running, total) => `instances running: ${running}/${total}`,
  },
  fr: {
    ok: 'connecté',
    instances: (running, total) => `instances en marche : ${running}/${total}`,
  },
  de: {
    ok: 'verbunden',
    instances: (running, total) => `laufende Instanzen: ${running}/${total}`,
  },
  es: {
    ok: 'conectado',
    instances: (running, total) => `instancias en marcha: ${running}/${total}`,
  },
};
