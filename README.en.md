<div align="center">

# IMPA Meet

**White-label video conferencing with AI assistants that listen, talk and present.**
Open source, self-hosted, ready for Docker Swarm and Portainer.

[![License Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-1a73e8)](LICENSE)
[![Docker Hub](https://img.shields.io/docker/v/impa365/impameet-platform?sort=semver&label=Docker%20Hub&logo=docker&logoColor=white)](https://hub.docker.com/r/impa365/impameet-platform)
[![Pulls](https://img.shields.io/docker/pulls/impa365/impameet-platform?logo=docker&logoColor=white)](https://hub.docker.com/r/impa365/impameet-platform)
![LiveKit](https://img.shields.io/badge/WebRTC-LiveKit-ff6352)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs)
![Python](https://img.shields.io/badge/Python-3.12-3776ab?logo=python&logoColor=white)
![Languages](https://img.shields.io/badge/languages-PT%20%7C%20EN%20%7C%20ES-34a853)

[Features](#features) · [Install](#install-in-10-minutes) · [Architecture](#architecture) ·
[Development](#development) · [Support](#support-the-project) · [Português](README.md)

<img src="docs/assets/room.png" alt="IMPA Meet meeting room in Google Meet style" width="900">

</div>

---

**IMPA Meet** is a complete video meeting platform you run on your own server and ship under
your own brand. What sets it apart are its **voice AI assistants**: they join the call as
participants, answer when called by name, reply in the speaker's language, hand the floor to
each other and can even share their screen to present web pages.

Created and maintained by **[Impa 365](https://impa365.com)**, AI automation for businesses.

## Features

**Meetings.** Google Meet-style interface (grid and spotlight, active speaker, control bar and
side panels), green room with device test, background blur and virtual backgrounds, screen
sharing, chat, reactions, hand raise, live captions and saved transcripts, MP4 recording
(LiveKit Egress), collaborative whiteboard (Excalidraw), polls, breakout rooms, scheduling with
e-mail invitations and calendar files.

**AI assistants.** Up to 4 per room, each with its own persona, knowledge base and voice. They
take turns and hand over by name. They work with any **OpenAI-compatible LLM** and use
**Fish Audio** for speech-to-text and text-to-speech, with **one voice per language**
(Portuguese, English, Spanish). An assistant can listen to everyone or only to whoever calls
its name, goes quiet on request and shares a screen through its own browser with an animated
cursor. The server has no default provider, model or voice: everything is chosen in the admin
panel, and provider keys are encrypted at rest.

**Access control.** Open, trusted or restricted rooms with an invite list. A waiting room lets
a moderator admit people. Rooms can also have a password, allow guests without an account and
set permissions per room (who can draw on the whiteboard, who can create polls).

**White-label SaaS.** Multiple organizations on one installation, each with its own branding,
default language and **custom domain with automatic HTTPS**. It has an admin panel (users,
agents, integrations, live rooms, audit log) and a super admin panel. Rooms are created with a
guided wizard. The UI is in PT/EN/ES with light and dark themes, and it is accessible (screen
readers, keyboard shortcuts, audio cues).

**Security.** Secrets are Docker Swarm secrets, provider keys are stored with AES-256-GCM, and
services talk over encrypted overlay networks isolated by role. Containers are read-only with
no capabilities, and images are tested and scanned (Trivy) for every release.

## Install in 10 minutes

You need a Linux server running **Docker Swarm** with **Traefik** and Let's Encrypt (the usual
Portainer setup). Point two DNS records at it (`meet.example.com` and `livekit.example.com`)
and open ports `80`, `443`, `7881/tcp` and `7882/udp`.

```bash
git clone https://github.com/impa365/impameet.git && cd impameet
bash deploy/scripts/prepare.sh            # creates every secret, never printing a value
cp deploy/.env.example deploy/.env        # set PLATFORM_HOST, LIVEKIT_HOST, SERVER_PUBLIC_IP
bash deploy/scripts/deploy.sh
```

**Portainer:** go to *Stacks → Add stack → Repository*, set the URL to
`https://github.com/impa365/impameet` and the compose path to `deploy/stack.yml`, add the same
three variables and name the stack `impameet`.

Then open `https://PLATFORM_HOST` and sign up (this creates your organization and its first
admin). Add your LLM and Fish Audio keys under **Admin → Integrations**, set up an agent under
**Admin → AI agents**, and create a room.

The full guide is in [docs/deploy.md](docs/deploy.md) (Portuguese): custom domains, e-mail,
updates, backups and troubleshooting.

## Architecture

| Service | Folder | Stack |
|---|---|---|
| `platform` | [`apps/platform`](apps/platform) | Next.js 15, React 18, LiveKit Components, PostgreSQL |
| `agent` | [`apps/agent`](apps/agent) | Python 3.12, LiveKit Agents, Fish Audio, OpenAI-compatible LLM |
| `screen` | [`apps/screen`](apps/screen) | Python 3.12, Playwright (headless Chromium), LiveKit RTC |
| `livekit`, `egress`, `redis`, `postgres` | [`deploy/stack.yml`](deploy/stack.yml) | Official images, pinned versions |

Ready-made images are on **Docker Hub**:
[`impa365/impameet-platform`](https://hub.docker.com/r/impa365/impameet-platform),
[`impa365/impameet-agent`](https://hub.docker.com/r/impa365/impameet-agent) and
[`impa365/impameet-screen`](https://hub.docker.com/r/impa365/impameet-screen). Each release is published under its
version number (for example `1.0.0`) and as `latest`.

## Development

```bash
cd apps/platform && npm ci && npm run dev        # Node 22, http://localhost:3000
cd apps/agent && uv sync && uv run pytest        # Python 3.12 (same for apps/screen)
docker build --target test apps/<app>            # the full suite, inside the image
bash deploy/scripts/release.sh 1.2.0             # test, scan and publish to Docker Hub
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License and credits

Licensed under the **[Apache License 2.0](LICENSE)**. You may use, modify, redistribute and
sell it, **as long as you keep the credits**: every copy or derivative must include the
[`NOTICE`](NOTICE) file crediting **Impa 365** as the creator, along with the copyright
notices in the source. The names "Impa 365", "IMPA365" and "IMPA Meet" and their logos are not
licensed, so a derivative product must use a different name.

## Support the project

IMPA Meet is free and open. If it helps you or your business, you can support it with a Pix
(Brazil's instant payment) of any amount to **`pix1@impa365.com`**, or scan the QR code in the
[Portuguese README](README.md#apoie-o-projeto). A ⭐ on the repository helps a lot too.

---

<div align="center">

Made by **[Impa 365](https://impa365.com)** · [contato@impa365.com](mailto:contato@impa365.com)

</div>
