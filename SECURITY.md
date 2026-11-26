# Security

## Reporting a vulnerability in Evieverse

Write to [contact@techfalos.com](mailto:contact@techfalos.com). Please don't open a public issue or pull request for it: a public report reaches attackers before the people who run instances can update.

Say what you can of:

- what the problem is, and what someone could do with it;
- how to reproduce it: the requests, the settings that matter, and the version or commit you tried it on;
- whether anyone else knows of it yet.

You'll get a reply, and credit for the find when the fix is released, if you'd like it.

## What this covers

The code in this repository: the server, its compactor and its trust plugins (the Rust under `compactor/`), the CLI it ships, the Docker images the `Dockerfile` builds, and the Terraform modules under `deploy/terraform`.

Fixes go into the latest release. Earlier releases aren't patched, so an instance is kept safe by updating it.

## A problem with one instance

Each Evieverse instance is run by its own operator, and this project runs none of them for anyone else. For a problem with a particular instance (how it's configured, what's posted on it, an account on it), write to that instance's operator: `GET /rules` on the instance gives its support address.

If the problem is in the code and would affect every instance, it belongs here.

## Things that help to know

- API keys. A key that may have leaked is replaced with `POST /users/:userId/key` or `evieverse key rotate`: the old one stops working at once ([API.md](docs/API.md#post-usersuseridkey)).
- The admin key and the signing key of a deployment are in its Terraform state, in plain text ([IAC.md](docs/IAC.md#the-admin-account)). Keep the state where only the deployment's operators can read it.
- The first admin's key of an instance in Docker is in a file on the instance's volume, `/app/data/admin-profile.json`, from its first start until someone deletes it ([DOCKER.md](docs/DOCKER.md#the-first-admin)). Copy it to the CLI, then delete it.
- Requests to other servers. An instance asks other servers for their public keys and for the attestations of posts it holds reposts of, at addresses users chose. Those requests are held to `https`, port 443 and public addresses, with no redirects ([APP.md](docs/APP.md#post-repost)). A way around those rules is a vulnerability.
