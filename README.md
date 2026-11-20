# Incus for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings the **containers and virtual machines of an Incus server** (or
LXD, same API) into Gladys, through the Incus REST API over HTTPS on the local
network: their state, their CPU and memory use, their IP address, and a switch
to start or stop each of them. No cloud, no account.

> Developed without a real Incus server: feedback welcome in the
> [issues](https://github.com/guim31/gladys-incus/issues). Tested against
> answers shaped after the Incus API and a local TLS server checking client
> certificates the way Incus does (see below), not against a real Incus, LXD
> or Gladys instance.

Not to be confused with Proxmox VE, whose LXC containers and VMs are managed
by Proxmox through another API.

## Features

- **One device per instance** you choose in the Discovery tab (containers and
  VMs, every project), identified by its name and project:
  - Running, a switch: off shuts the instance down cleanly, on starts it (or
    resumes it when paused);
  - CPU, in % of the threads the instance may use;
  - Memory, in MB;
  - IP address.
- **A device for the server**: reachable, version, instances running and in
  total.
- **Scene triggers**: instance stopped unexpectedly (crash, shutdown inside,
  out of memory — never the stops asked by Gladys), Incus unreachable.
- **Scene actions** and configuration buttons: start, stop, restart an
  instance; test the connection; trust the server certificate again.
- **Dashboard widget**: instances running and in error, the list with the
  problems first, Start or Stop and Restart buttons for a chosen instance.
- English, French, German and Spanish.

## Requirements

- Gladys Assistant 5.1.0 or later.
- Incus 6.0 or later, or LXD 5.21 or later, with its API on the network:
  `incus config set core.https_address :8443`.
- A trust token for Gladys: `incus config trust add gladys` (optionally
  `--restricted --projects …`).

## Installation

In Gladys, **Integrations → Install from GitHub**, address
`https://github.com/guim31/gladys-incus`. Then paste the trust token (and the
address of the server if the token does not list the right one) in the
configuration, **Test the connection**, and add the instances to follow in the
**Discovery** tab. The full guide: [English](docs/en.md),
[français](docs/fr.md), [Deutsch](docs/de.md), [español](docs/es.md).

## How it works

- **Authentication**: at its first start the integration creates its own
  client certificate (ECDSA P-384, ten years) in `/data`, written by
  `src/incus/cert.js` with `node:crypto` only. The trust token is presented
  once (`POST /1.0/certificates`); Incus then trusts that certificate. The
  certificate can also be trusted by hand
  (`incus config trust add-certificate client.crt`).
- **Server pinning**: an Incus server presents a self-signed certificate. Its
  SHA-256 fingerprint comes from the token, or is trusted on first use, and is
  checked right after the TLS handshake, before any byte of a request is
  sent.
- **Reads**: `GET /1.0`, `GET /1.0/instances?recursion=2&all-projects=true`
  (without `all-projects` on a server lacking that extension) and, once,
  `GET /1.0/resources` for the CPU threads, at the interval of the
  configuration (30 seconds by default). The CPU use is the difference of the
  CPU time between two reads.
- **Operations**: `PUT /1.0/instances/{name}/state?project=…` (start, stop
  with a 30 s clean shutdown, restart, unfreeze), then the operation is
  waited for.
- The devices are published with `should_poll: false`: the container reads
  Incus on its own timer, so that the scene trigger fires for every instance,
  added to Gladys or not. The last state of each instance and the pin are kept
  in `/data/incus-state.json`.

## Checked for real, and what was not

On 20/11/2026:

- the integration's image, run with `--cap-drop ALL --security-opt
no-new-privileges --read-only --memory 256m --pids-limit 256`, a `/data`
  volume and a bridge network: it imports `src/app.js`, retries the
  connection to an absent Gladys calmly (no secret in the logs), 20 MiB of
  memory at rest;
- in that same locked container, the tests of the client, the hub and the
  widget against the fake Gladys of the SDK, and the real TLS transport
  against a local HTTPS server that authenticates clients by their
  certificate and trusts them by a token, as Incus does: trust, refused or
  reused token, pinned certificate (the token never sent to another server),
  plain HTTP server, closed port.

Not checked: a real Incus or LXD server (running Incus in Docker needs a
privileged container, not allowed on the development machine), a real Gladys
instance, a cluster, VMs and their agent. The answers of
`test/fixtures/incus/` are shaped after the structures of the Incus code
(`shared/api`), not captured from a server.

## Limitations

- One Incus server per integration.
- No snapshots, migrations, consoles or images.
- A stop is always clean (30 seconds at most), never forced.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`),
a fake Incus server behind the transport seam (`test/helpers/fakeIncus.js`)
and a local HTTPS server for the transport (`test/transport.test.js`). See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [Incus](https://linuxcontainers.org/incus/) (Apache-2.0) and its
  [REST API documentation](https://linuxcontainers.org/incus/docs/main/rest-api/);
  the API structures of the [lxc/incus](https://github.com/lxc/incus)
  repository shaped the test fixtures. The logo on the cover is the official
  Incus logo, from the
  [linuxcontainers.org](https://github.com/lxc/linuxcontainers.org) site.
- The architecture and the conformity tests follow
  [gladys-podman](https://github.com/guim31/gladys-podman) and
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by the Linux
Containers project, Incus, or Canonical (LXD).

## License

Apache-2.0
