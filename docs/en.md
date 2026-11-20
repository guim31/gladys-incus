# Incus

This integration brings the **containers and virtual machines of an Incus server** (or LXD, same API) into Gladys: one device per instance you choose,
with its state, its CPU and memory use and its IP address, plus a device for
the server itself. An instance device is a switch: turn it off to stop the
instance, on to start it. Scenes can react when an instance stops without
Gladys asking, and start, stop or restart an instance; a dashboard widget
lists the instances, the problems first.

It talks to the **Incus REST API** over HTTPS on your local network, with a
client certificate of its own; nothing goes through the cloud.

Developed without a real Incus server: feedback welcome on
[the issues](https://github.com/guim31/gladys-incus/issues). The integration
was tested against answers shaped after the Incus API and against a local TLS
server checking client certificates the way Incus does, not against a real
Incus or LXD, nor a real Gladys instance.

Not to be confused with Proxmox VE: its LXC containers and VMs are managed by
Proxmox, through another API (see the Proxmox integration of the store).

## What you need

- Gladys Assistant 5.1.0 or later.
- An Incus server (6.0 or later) or an LXD server (5.21 or later), reachable
  from the Gladys machine.
- A shell on that server, once, to open the API to the network and create a
  trust token.

## Getting started

### 1. Open the API to the network

By default Incus only listens on its local Unix socket. On the server:

```sh
incus config set core.https_address :8443
```

The API is then served over HTTPS on port 8443. Open this port to the Gladys
machine only; never expose it to the Internet.

### 2. Create a trust token

Incus only answers the clients whose certificate it trusts. The integration
creates its own certificate at its first start (kept in its `/data` volume);
a token lets Incus trust it:

```sh
incus config trust add gladys
```

Copy the line it prints. To keep Gladys away from some instances, restrict
the certificate to some projects:
`incus config trust add gladys --restricted --projects default`.
With LXD, the same commands start with `lxc` instead of `incus`.

### 3. Configure the integration

In Gladys, **Integrations → Incus → Configuration**:

- **Incus server address**: `192.168.1.30` (port 8443 when omitted,
  `https://…` accepted). Empty: the first address listed in the token;
- **Trust token**: the line copied above. It is used once: Incus then trusts
  the certificate of Gladys, and the token is spent;
- **Server name** (optional): shown in the device name, the widget and the
  messages;
- **Refresh interval**: 30 seconds by default;
- **Language of the names**: the language of the feature names and of the
  action messages.

**Test the connection** reads Incus and says what it found.

The token also carries the fingerprint of the server certificate: Gladys
checks it at every connection, before sending anything. Without a token, the
first certificate seen is kept. If the server changes its certificate (a
reinstallation), Gladys refuses to talk to it; check why, then use **Trust the server certificate again**.

Without a token, you can also trust the certificate by hand: copy
`client.crt` from the `/data` volume of the integration on the Gladys
machine, then `incus config trust add-certificate client.crt` on the server.

### 4. Add the devices

In the **Discovery** tab, add the server and the instances to follow. An
instance is identified by its **name** and its project (`project/name`
outside the default project): rebuilt under the same name, it keeps its
device and its history.

## The devices

### The server

- **Reachable**: 1 while Incus answers;
- **Version**: `Incus 6.18` or `LXD 5.21.3`;
- **Instances running**, **Instances** (in total).

### Instances

- **Running**: a switch; off asks the instance to shut down cleanly (30
  seconds at most), on starts it (or resumes it when paused);
- **CPU**: the processor use since the previous read, in % of the threads
  the instance may use (`limits.cpu`, or every thread of the server);
- **Memory**: the memory used, in MB;
- **IP address**: the first global IPv4 address (IPv6 otherwise). A VM only
  reports it with its agent (`incus-agent`) running.

A stopped instance uses 0 % and 0 MB. An instance deleted from the server
shows as unreachable.

## Dashboard

The **Incus instances** widget shows the instances running out of the total,
those in error, and the list of the instances: the added ones (all of them
when none is added), the problems first, with their IP address. Choose an
instance in its settings to get **Start** or **Stop** and **Restart** buttons
for it; **Refresh** reads Incus again. The list and each button can be hidden.

## Scenes

### Triggers

- **Instance stopped unexpectedly**: a running container or VM stopped or went
  into error without Gladys asking (crash, shutdown inside the guest, out of
  memory, `incus stop` by hand). A stop asked by Gladys (switch, action,
  widget, scene) fires nothing; a pause neither. Variables: instance, project,
  state. Can be limited to one instance device.
- **Incus unreachable**: the server no longer answers (two reads in a row, 15
  seconds apart); announced once per outage.

### Actions

- **Start an instance**, **Stop an instance**, **Restart an instance**: the
  instance is chosen among the instance devices; the outputs are its name and
  whether it runs afterwards. The same three are buttons of the configuration
  screen, next to **Test the connection** and **Trust the server certificate again**.

### Scene ideas

- Notify me when the database container stops unexpectedly.
- Start the game server VM when I come home on Friday evening, stop it at
  midnight.
- Restart the media server container every night at 4.

## Troubleshooting

- **The server does not answer**: check `core.https_address`
  (`incus config get core.https_address`), the port and the firewall.
- **Gladys is not trusted yet**: paste a token in the configuration (above).
- **Trust token refused**: it expired or was already used; create a new one.
- **The server certificate changed**: after a reinstallation, use **Trust the server certificate again**; otherwise, check that nothing intercepts the
  connection.
- **Incus refused: the certificate of Gladys is restricted**: the certificate
  is restricted to projects that do not hold this instance.
- **A VM has no IP address**: start its agent (`incus-agent`).
- **Logs**: set `LOG_LEVEL=debug` on the integration to see every read.

## Limits

- One Incus server per integration; for a cluster, the members are read
  through the server given.
- No snapshots, migrations, consoles or images: state, CPU, memory, address,
  start, stop and restart only.
- A stop is always a clean shutdown (30 seconds at most): a frozen guest is
  not forced.
- Not affiliated with the Linux Containers project, Incus or Canonical (LXD).
