// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `instances`.
//
// The use case: a glance at the wall tablet tells whether the home lab's
// containers and VMs are up, and one of them can be started or stopped from
// there (the game server for the evening, the test VM). Two tiles (running
// out of total, stopped on an error), then the instances, the problems
// first: Error, Stopped, Frozen, Running — or the instance devices only,
// once some were added. An instance chosen in the settings gets Start or
// Stop and Restart buttons.
//
// The names are the ones given in Gladys when the device was added, the
// Incus names otherwise. The list, the buttons and Refresh can be hidden.
//
// Budget (8 components, 2 texts, 4 buttons): one heading, two tiles, one
// status list of ten rows at most, three buttons.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES, deviceIds, instanceDeviceId, parseDeviceId } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { OPERATIONS } from './incus/client.js';
import { INSTANCE_TYPES, STATUS, instanceLabel } from './incus/model.js';
import { ACTION_TEXT, ActionFailure, allLanguages, errorText, labelled, pick } from './texts.js';

// Action keys of the buttons: permanent once published.
export const ACTIONS = Object.freeze({
  START: 'start',
  STOP: 'stop',
  RESTART: 'restart',
  REFRESH: 'refresh',
});

export const MAX_ROWS = 10;

export const TEXT = {
  notConfigured: {
    en: 'Enter the address of the Incus server in the configuration of the integration.',
    fr: "Saisissez l'adresse du serveur Incus dans la configuration de l'intégration.",
    de: 'Gib die Adresse des Incus-Servers in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección del servidor Incus en la configuración de la integración.',
  },
  waiting: {
    en: 'Waiting for the first answer of Incus…',
    fr: "En attente de la première réponse d'Incus…",
    de: 'Warte auf die erste Antwort von Incus …',
    es: 'Esperando la primera respuesta de Incus…',
  },
  running: { en: 'Running', fr: 'En marche', de: 'Laufend', es: 'En marcha' },
  stopped: { en: 'Stopped', fr: 'Arrêtée', de: 'Gestoppt', es: 'Detenida' },
  frozen: { en: 'Paused', fr: 'En pause', de: 'Pausiert', es: 'En pausa' },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  none: {
    en: 'No instance',
    fr: 'Aucune instance',
    de: 'Keine Instanz',
    es: 'Ninguna instancia',
  },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otras' },
  start: { en: 'Start', fr: 'Démarrer', de: 'Starten', es: 'Iniciar' },
  stop: { en: 'Stop', fr: 'Arrêter', de: 'Stoppen', es: 'Detener' },
  restart: { en: 'Restart', fr: 'Redémarrer', de: 'Neu starten', es: 'Reiniciar' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Incus read again.',
    fr: 'Incus relu.',
    de: 'Incus neu gelesen.',
    es: 'Incus leído de nuevo.',
  },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
// A boolean setting left alone is shown (settings saved before it existed too).
const shown = (settings, key) => settings?.[key] !== false && settings?.[key] !== 'false';

function message(text, language, ttl = 300) {
  return {
    ttl_seconds: ttl,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** Sort order: the problems first. */
function rank(instance) {
  if (instance.status === STATUS.ERROR) {
    return 0;
  }
  if (instance.running) {
    return 3;
  }
  return instance.status === STATUS.FROZEN ? 2 : 1;
}

/** One row of the status list. */
function row(hub, instance, language) {
  const label = instanceLabel(instance);
  const name = hub.gladysName(instanceDeviceId(hub.gladys, instance), label);
  const vm = instance.type === INSTANCE_TYPES.VM;
  let value = t(TEXT.running, language);
  let icon = vm ? 'monitor' : 'box';
  let color = WIDGET_COLORS.SUCCESS;
  if (instance.status === STATUS.ERROR) {
    value = t(TEXT.error, language);
    icon = 'alert-triangle';
    color = WIDGET_COLORS.DANGER;
  } else if (instance.status === STATUS.FROZEN) {
    value = t(TEXT.frozen, language);
    icon = 'pause-circle';
    color = WIDGET_COLORS.WARNING;
  } else if (!instance.running) {
    value = t(TEXT.stopped, language);
    icon = 'stop-circle';
    color = WIDGET_COLORS.NEUTRAL;
  } else if (instance.address) {
    value = instance.address;
  }
  return { label: fit(name, 40), value: fit(value, 40), icon, color };
}

/** The rows: the added instance devices when there are some, every instance otherwise. */
export function instanceRows(hub, view, language) {
  const added = new Set(
    hub
      .createdDevices()
      .filter((entry) => entry.type === DEVICE_TYPES.INSTANCE)
      .map((entry) => entry.device.external_id),
  );
  const listed = view.snapshot.instances
    .filter((i) => added.size === 0 || added.has(instanceDeviceId(hub.gladys, i)))
    .sort((a, b) => rank(a) - rank(b) || instanceLabel(a).localeCompare(instanceLabel(b)));
  const rows = listed.map((instance) => row(hub, instance, language));
  if (rows.length === 0) {
    return [
      { label: t(TEXT.none, language), value: '0', icon: 'box', color: WIDGET_COLORS.NEUTRAL },
    ];
  }
  if (rows.length > MAX_ROWS) {
    const kept = rows.slice(0, MAX_ROWS - 1);
    kept.push({
      label: t(TEXT.more, language),
      value: `+${rows.length - kept.length}`,
      icon: 'more-horizontal',
      color: WIDGET_COLORS.NEUTRAL,
    });
    return kept;
  }
  return rows;
}

const button = (text, icon, key, params) => ({
  type: 'button',
  label: fit(text, 24),
  icon,
  style: 'secondary',
  action: { key, params },
});

/** Start or Stop, and Restart, for the instance chosen in the settings. */
function instanceButtons(hub, view, settings, language) {
  const parsed = parseDeviceId(hub.gladys, settings?.instance);
  if (!parsed || parsed.type !== DEVICE_TYPES.INSTANCE || !shown(settings, 'show_buttons')) {
    return [];
  }
  const instance = view.snapshot.instances.find(
    (i) => instanceDeviceId(hub.gladys, i) === settings.instance,
  );
  if (!instance) {
    return [];
  }
  const params = { instance: settings.instance };
  const name = hub.gladysName(settings.instance, instanceLabel(instance));
  const label = (text) => `${t(text, language)} ${name}`;
  return [
    instance.running
      ? button(label(TEXT.stop), 'square', ACTIONS.STOP, params)
      : button(label(TEXT.start), 'play', ACTIONS.START, params),
    button(label(TEXT.restart), 'rotate-cw', ACTIONS.RESTART, params),
  ];
}

async function get(hub, { settings = {}, language = 'en' } = {}) {
  if (!hub.client) {
    return message(TEXT.notConfigured, language);
  }
  const view = hub.view();
  const title = fit(hub.gladysName(deviceIds(hub.gladys, DEVICE_TYPES.HOST).device, view.name), 40);
  const refresh = shown(settings, 'show_refresh')
    ? [button(t(TEXT.refresh, language), 'refresh-cw', ACTIONS.REFRESH, {})]
    : [];
  if (!view.online) {
    if (!view.error) {
      return message(TEXT.waiting, language, 30);
    }
    return {
      ttl_seconds: 30,
      components: [
        { type: 'text', variant: 'heading', text: title },
        {
          type: 'text',
          variant: 'body',
          text: labelled(title, errorText(view.error, language), language),
        },
        ...refresh,
      ],
    };
  }
  const { totals } = view;
  const errors = view.snapshot.instances.filter((i) => i.status === STATUS.ERROR).length;
  const components = [
    { type: 'text', variant: 'heading', text: title },
    {
      type: 'value',
      value: `${totals.running}/${totals.total}`,
      label: t(TEXT.running, language),
      icon: 'server',
      color: WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: errors,
      label: t(TEXT.error, language),
      icon: 'alert-triangle',
      color: errors > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    },
  ];
  if (shown(settings, 'show_list')) {
    components.push({ type: 'status', items: instanceRows(hub, view, language) });
  }
  return {
    ttl_seconds: 60,
    components: [...components, ...instanceButtons(hub, view, settings, language), ...refresh],
  };
}

const OPERATION_OF = {
  [ACTIONS.START]: OPERATIONS.START,
  [ACTIONS.STOP]: OPERATIONS.STOP,
  [ACTIONS.RESTART]: OPERATIONS.RESTART,
};

async function action(hub, { actionKey, params = {} }) {
  if (actionKey === ACTIONS.REFRESH) {
    if (!hub.client) {
      throw new ActionFailure(ACTION_TEXT.notConfigured);
    }
    await hub.pollNow();
    if (hub.error) {
      const name = hub.config.name;
      throw new ActionFailure(
        allLanguages((language) => labelled(name, errorText(hub.error, language), language)),
      );
    }
    return { message: TEXT.refreshed };
  }
  const operation = OPERATION_OF[actionKey];
  if (!operation) {
    throw new ActionFailure(ACTION_TEXT.unknownAction);
  }
  const result = await hub.operate(params.instance, operation);
  return { message: result.message };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
