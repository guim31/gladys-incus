# Incus

Cette intégration amène dans Gladys les **conteneurs et machines virtuelles d'un serveur Incus** (ou LXD, même API) : un appareil par instance choisie,
avec son état, son usage du processeur et de la mémoire et son adresse IP,
plus un appareil pour le serveur lui-même. Un appareil instance est un
interrupteur : éteignez-le pour arrêter l'instance, allumez-le pour la
démarrer. Les scènes peuvent réagir quand une instance s'arrête sans que
Gladys le demande, et démarrer, arrêter ou redémarrer une instance ; un widget
du tableau de bord liste les instances, les problèmes d'abord.

Elle dialogue avec l'**API REST d'Incus** en HTTPS sur votre réseau local,
avec son propre certificat client ; rien ne passe par le cloud.

Développée sans vrai serveur Incus : vos retours sont les bienvenus sur
[les issues](https://github.com/guim31/gladys-incus/issues). L'intégration a
été testée sur des réponses calquées sur l'API d'Incus et contre un serveur
TLS local qui vérifie les certificats clients comme Incus, pas contre un vrai
Incus ou LXD, ni une vraie instance Gladys.

À ne pas confondre avec Proxmox VE : ses conteneurs LXC et ses VM sont gérés
par Proxmox, par une autre API (voir l'intégration Proxmox du store).

## Ce qu'il faut

- Gladys Assistant 5.1.0 ou plus récent.
- Un serveur Incus (6.0 ou plus récent) ou LXD (5.21 ou plus récent),
  joignable depuis la machine de Gladys.
- Un terminal sur ce serveur, une fois, pour ouvrir l'API au réseau et créer
  un jeton de confiance.

## Mise en route

### 1. Ouvrir l'API au réseau

Par défaut, Incus n'écoute que sur son socket Unix local. Sur le serveur :

```sh
incus config set core.https_address :8443
```

L'API est alors servie en HTTPS sur le port 8443. N'ouvrez ce port qu'à la
machine de Gladys ; ne l'exposez jamais sur Internet.

### 2. Créer un jeton de confiance

Incus ne répond qu'aux clients dont il connaît le certificat. L'intégration
crée son propre certificat à son premier démarrage (gardé dans son volume
`/data`) ; un jeton permet à Incus de lui faire confiance :

```sh
incus config trust add gladys
```

Copiez la ligne affichée. Pour tenir Gladys à l'écart de certaines instances,
restreignez le certificat à quelques projets :
`incus config trust add gladys --restricted --projects default`.
Avec LXD, les mêmes commandes commencent par `lxc` au lieu de `incus`.

### 3. Configurer l'intégration

Dans Gladys, **Intégrations → Incus → Configuration** :

- **Adresse du serveur Incus** : `192.168.1.30` (port 8443 s'il est omis,
  `https://…` accepté). Vide : la première adresse listée dans le jeton ;
- **Jeton de confiance** : la ligne copiée plus haut. Il sert une fois :
  Incus fait ensuite confiance au certificat de Gladys, et le jeton est
  consommé ;
- **Nom du serveur** (facultatif) : affiché dans le nom de l'appareil, le
  widget et les messages ;
- **Intervalle de rafraîchissement** : 30 secondes par défaut ;
- **Langue des noms** : la langue des noms des fonctionnalités et des
  messages des actions.

**Tester la connexion** lit Incus et dit ce qu'il a trouvé.

Le jeton porte aussi l'empreinte du certificat du serveur : Gladys la vérifie
à chaque connexion, avant d'envoyer quoi que ce soit. Sans jeton, le premier
certificat vu est retenu. Si le serveur change de certificat (une
réinstallation), Gladys refuse de lui parler ; vérifiez pourquoi, puis
utilisez **Faire de nouveau confiance au certificat**.

Sans jeton, vous pouvez aussi faire confiance au certificat à la main :
copiez `client.crt` depuis le volume `/data` de l'intégration sur la machine
de Gladys, puis `incus config trust add-certificate client.crt` sur le
serveur.

### 4. Ajouter les appareils

Dans l'onglet **Découverte**, ajoutez le serveur et les instances à suivre.
Une instance est identifiée par son **nom** et son projet (`projet/nom` hors
du projet par défaut) : reconstruite sous le même nom, elle garde son
appareil et son historique.

## Les appareils

### Le serveur

- **Joignable** : 1 tant qu'Incus répond ;
- **Version** : `Incus 6.18` ou `LXD 5.21.3` ;
- **Instances en marche**, **Instances** (au total).

### Les instances

- **En marche** : un interrupteur ; éteint, il demande à l'instance de
  s'arrêter proprement (30 secondes au plus), allumé, il la démarre (ou la
  reprend si elle est en pause) ;
- **Processeur** : l'usage du processeur depuis la lecture précédente, en %
  des threads que l'instance peut utiliser (`limits.cpu`, ou tous ceux du
  serveur) ;
- **Mémoire** : la mémoire utilisée, en Mo ;
- **Adresse IP** : la première adresse IPv4 globale (IPv6 sinon). Une VM ne
  la donne qu'avec son agent (`incus-agent`) en marche.

Une instance arrêtée utilise 0 % et 0 Mo. Une instance supprimée du serveur
apparaît injoignable.

## Tableau de bord

Le widget **Instances Incus** affiche les instances en marche sur le total,
celles en erreur, et la liste des instances : celles ajoutées (toutes si
aucune ne l'est), les problèmes d'abord, avec leur adresse IP. Choisissez une
instance dans ses réglages pour avoir les boutons **Démarrer** ou **Arrêter**
et **Redémarrer** ; **Actualiser** relit Incus. La liste et chaque bouton
peuvent être masqués.

## Scènes

### Déclencheurs

- **Instance arrêtée de façon inattendue** : un conteneur ou une VM en marche
  s'est arrêté ou est passé en erreur sans que Gladys le demande (plantage,
  arrêt depuis l'intérieur, mémoire, `incus stop` à la main). Un arrêt demandé
  par Gladys (interrupteur, action, widget, scène) ne déclenche rien ; une
  pause non plus. Variables : instance, projet, état. Peut être limité à un
  appareil instance.
- **Incus injoignable** : le serveur ne répond plus (deux lectures de suite,
  à 15 secondes d'intervalle) ; annoncé une fois par panne.

### Actions

- **Démarrer une instance**, **Arrêter une instance**, **Redémarrer une instance** : l'instance se choisit parmi les appareils instance ; les
  sorties sont son nom et si elle tourne ensuite. Les trois sont aussi des
  boutons de l'écran de configuration, à côté de **Tester la connexion** et
  **Faire de nouveau confiance au certificat**.

### Idées de scènes

- Me prévenir quand le conteneur de la base de données s'arrête de façon
  inattendue.
- Démarrer la VM du serveur de jeu quand je rentre le vendredi soir,
  l'arrêter à minuit.
- Redémarrer le conteneur du serveur multimédia chaque nuit à 4 h.

## Dépannage

- **Le serveur ne répond pas** : vérifiez `core.https_address`
  (`incus config get core.https_address`), le port et le pare-feu.
- **Gladys n'est pas encore autorisé** : collez un jeton dans la
  configuration (plus haut).
- **Jeton de confiance refusé** : il a expiré ou a déjà servi ; créez-en un
  nouveau.
- **Le certificat du serveur a changé** : après une réinstallation, utilisez
  **Faire de nouveau confiance au certificat** ; sinon, vérifiez que rien
  n'intercepte la connexion.
- **Incus a refusé : le certificat de Gladys est restreint** : le certificat
  est limité à des projets qui ne contiennent pas cette instance.
- **Une VM n'a pas d'adresse IP** : démarrez son agent (`incus-agent`).
- **Logs** : mettez `LOG_LEVEL=debug` sur l'intégration pour voir chaque
  lecture.

## Limites

- Un serveur Incus par intégration ; pour un cluster, les membres sont lus à
  travers le serveur indiqué.
- Ni instantanés, ni migrations, ni consoles, ni images : état, processeur,
  mémoire, adresse, démarrage, arrêt et redémarrage seulement.
- Un arrêt est toujours propre (30 secondes au plus) : un invité figé n'est
  pas forcé.
- Sans lien avec le projet Linux Containers, Incus ou Canonical (LXD).
