# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration keeps:

- in Gladys, the configuration: the address of the Incus server and the trust
  token (a `secret` field; single use, spent once Incus trusted Gladys);
- in `/data`: `client.key` and `client.crt`, the client certificate Incus
  trusts (the key is readable by the integration only, mode 0600: whoever
  holds it controls the instances the certificate may reach), and
  `incus-state.json` (the last state of each instance, and the fingerprint of
  the server certificate).

It only talks to the Incus API on the local network, over HTTPS with that
client certificate; the server certificate is pinned by its fingerprint and
checked before any request is sent. Neither the token nor the key appears in
the logs. Restrict the certificate on the server
(`incus config trust add gladys --restricted --projects …`) to limit what
Gladys can reach.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
Incus (see its [security policy](https://github.com/lxc/incus/security/policy)),
LXD, and the other third-party services and devices.
