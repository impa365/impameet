# Guia de instalação e operação

Este guia leva uma instalação do zero até a produção em Docker Swarm, pela linha de comando ou
pelo Portainer. Para uma visão geral do projeto, veja o [README](../README.md).

- [1. Antes de começar](#1-antes-de-começar)
- [2. Segredos](#2-segredos)
- [3. Subir a stack](#3-subir-a-stack)
- [4. Primeiro acesso](#4-primeiro-acesso)
- [5. Opcionais](#5-opcionais)
- [6. Atualizar](#6-atualizar)
- [7. Backup](#7-backup)
- [8. Solução de problemas](#8-solução-de-problemas)

## 1. Antes de começar

### Servidor

| | Mínimo | Recomendado |
|---|---|---|
| CPU | 4 vCPU | 8 vCPU (gravação usa cerca de 1,5 núcleo por sala gravada) |
| Memória | 8 GB | 16 GB |
| Disco | 40 GB SSD | mais espaço conforme o volume de gravações |
| Sistema | Linux x86_64 com Docker 24+ em modo Swarm | |

Se o Docker ainda não estiver em modo Swarm, rode `docker swarm init`.

### Traefik

A stack usa um Traefik que já esteja rodando no Swarm, ligado a uma rede overlay externa e com
um resolvedor do Let's Encrypt. Esse é o padrão das instalações com Portainer. Os nomes usados
por padrão são estes, e cada um pode ser trocado por uma variável:

| O quê | Padrão | Variável |
|---|---|---|
| Rede do Traefik | `network_public` | `TRAEFIK_NETWORK` |
| Resolvedor de certificados | `letsencryptresolver` | `TRAEFIK_CERT_RESOLVER` |
| Entrypoint HTTPS | `websecure` | `TRAEFIK_ENTRYPOINT` |

### DNS

Crie dois registros `A` apontando para o IP público do servidor:

```
meet.seudominio.com     ->  203.0.113.10   (a plataforma)
livekit.seudominio.com  ->  203.0.113.10   (o servidor de mídia)
```

### Firewall

O áudio e o vídeo não passam pelo Traefik: vão direto ao servidor por duas portas fixas, sem
faixa de portas UDP.

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp    # WebRTC por TCP (redes que bloqueiam UDP)
ufw allow 7882/udp    # WebRTC por UDP (todas as conexões multiplexadas)
```

Se o seu provedor tem firewall próprio (AWS, Hetzner, Oracle...), libere as mesmas portas lá
também.

## 2. Segredos

Todos os segredos ficam no **Docker Swarm**: criptografados em repouso e em trânsito, e
montados em memória só nos containers que precisam deles. Nada vai para arquivo, variável de
ambiente ou log.

```bash
git clone https://github.com/impa365/impameet.git && cd impameet
bash deploy/scripts/prepare.sh
```

| Segredo | Para quê |
|---|---|
| `meet_livekit_keys`, `meet_livekit_api_key`, `meet_livekit_api_secret` | Par de chaves do LiveKit |
| `meet_pg_password`, `meet_platform_database_url` | Banco de dados |
| `meet_platform_encryption_key` | Criptografa (AES-256-GCM) as chaves dos provedores salvas no painel |
| `meet_platform_internal_token` | Comunicação entre serviços (agente e Traefik → plataforma) |
| `meet_screen_token` | Comunicação entre o agente e o serviço de tela |

> **Importante:** a chave de criptografia só existe dentro do Swarm. Inclua
> `/var/lib/docker/swarm` nos backups do servidor. Sem ela, as chaves de provedores
> cadastradas no painel não podem ser recuperadas e precisam ser digitadas de novo.

As chaves do LLM e do Fish Audio **não** são segredos do servidor: cada organização as cadastra
no painel (Admin → Integrações), e elas ficam criptografadas no banco.

## 3. Subir a stack

### Variáveis

| Variável | Obrigatória | Exemplo | Descrição |
|---|---|---|---|
| `PLATFORM_HOST` | sim | `meet.seudominio.com` | Endereço da plataforma |
| `LIVEKIT_HOST` | sim | `livekit.seudominio.com` | Endereço do servidor de mídia |
| `SERVER_PUBLIC_IP` | sim | `203.0.113.10` | IP público anunciado aos navegadores |
| `IMPAMEET_VERSION` | não | `1.0.0` | Versão das imagens (padrão `latest`) |
| `DEFAULT_TENANT` | não | `minhaempresa` | Organização servida no domínio principal |
| `DOCKER_BRIDGE_SUBNET` | não | `172.18.0.0/16` | Sub-rede do `docker_gwbridge` |
| `TRAEFIK_*` | não | | Veja a seção [Traefik](#traefik) |
| `LOG_LEVEL` | não | `INFO` | Nível de log do agente |

Para conferir a sub-rede do bridge: `docker network inspect docker_gwbridge -f '{{(index .IPAM.Config 0).Subnet}}'`.

### Pelo Portainer

1. **Stacks → Add stack**, com o nome `impameet`.
2. Escolha **Repository**, com a URL `https://github.com/impa365/impameet`, a referência
   `refs/heads/main` (ou uma tag de versão) e o compose path `deploy/stack.yml`.
3. Em **Environment variables**, adicione `PLATFORM_HOST`, `LIVEKIT_HOST` e
   `SERVER_PUBLIC_IP`, além dos opcionais que quiser.
4. Clique em **Deploy the stack**.

Também dá para colar o conteúdo de [`deploy/stack.yml`](../deploy/stack.yml) no **Web editor**:
o arquivo não depende de nenhum outro.

### Pela linha de comando

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
bash deploy/scripts/deploy.sh          # nome da stack: impameet
```

Acompanhe a subida com `docker service ls`. A plataforma aplica as migrações do banco
sozinha ao iniciar.

## 4. Primeiro acesso

1. Abra `https://PLATFORM_HOST` e clique em **Criar conta**. Isso cria a organização e o
   primeiro administrador.
2. Em **Admin → Integrações**, cadastre:
   - um **LLM compatível com OpenAI**: URL base (por exemplo `https://api.openai.com/v1`) e
     chave. O botão de teste confere a conexão e lista os modelos;
   - o **Fish Audio**: chave da API em [fish.audio](https://fish.audio).
3. Em **Admin → Agentes de IA**, configure o agente: persona, modelo do LLM, modelo de voz,
   modelo de transcrição e **pelo menos uma voz** (o ID do modelo de voz no Fish Audio) para
   cada idioma em que ele deve responder. Um agente incompleto não entra nas reuniões.
4. Crie uma sala em **Nova sala** e marque os assistentes.

Para tornar um usuário **super admin** (gerencia todas as organizações):

```bash
docker exec "$(docker ps -q -f name=impameet_platform | head -1)" \
  node scripts/superadmin.mjs voce@seudominio.com
```

## 5. Opcionais

### Domínio próprio por organização

Cada organização pode usar o próprio domínio (`reunioes.cliente.com`), com certificado
automático. Para isso, o Traefik consulta a plataforma pelo *HTTP provider*, e o script cuida
dessa configuração. Em uma instalação nova, rode-o **no lugar** do token interno do
`prepare.sh`:

```bash
TRAEFIK_SERVICE=traefik_traefik bash deploy/scripts/prepare.sh
```

Se a stack já estiver no ar, faça assim:

```bash
docker stack rm impameet
docker secret rm meet_platform_internal_token
bash deploy/scripts/traefik-provider.sh traefik_traefik
bash deploy/scripts/deploy.sh          # ou "Update the stack" no Portainer
```

Use `TRAEFIK_PROVIDER=docker` se o seu Traefik for v2.

### Convites por e-mail

```bash
bash deploy/scripts/secret-set.sh meet_smtp_url   # smtps://usuario:senha@smtp.seudominio.com:465
```

Em seguida, no serviço `platform` do `stack.yml`, adicione o segredo `meet_smtp_url`,
descomente `SMTP_URL_FILE` e `MAIL_FROM`, e atualize a stack.

### Sem compartilhamento de tela pela IA

Remova o serviço `screen` e as variáveis `SCREEN_URL` e `SCREEN_TOKEN_FILE` do serviço
`agent`.

## 6. Atualizar

- **Portainer:** abra a stack e use **Pull and redeploy**.
- **Linha de comando:** rode `git pull` e depois `bash deploy/scripts/deploy.sh`.

Em produção, fixe uma versão com `IMPAMEET_VERSION=1.2.3` e atualize de propósito. As
atualizações dos serviços são feitas sem derrubar os anteriores (`start-first`) e voltam
sozinhas para a versão anterior se a nova não ficar saudável.

Para trocar um segredo sem parar o serviço, rode
`bash deploy/scripts/secret-rotate.sh <segredo> impameet_<serviço>`.

## 7. Backup

```bash
# Banco de dados
docker exec "$(docker ps -q -f name=impameet_postgres | head -1)" \
  pg_dump -U impa -d impa_meet --format=custom > impameet-$(date +%F).dump

# Gravações
docker run --rm -v impameet_recordings:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/recordings-$(date +%F).tgz -C /data .

# Estado do Swarm (inclui os segredos): com o Docker parado ou num snapshot do disco
tar czf swarm-$(date +%F).tgz -C /var/lib/docker swarm
```

Guarde os backups fora do servidor e criptografados: eles contêm dados pessoais e segredos.

## 8. Solução de problemas

| Sintoma | O que verificar |
|---|---|
| A página não abre ou o certificado é inválido | Os registros DNS, as labels do Traefik (`TRAEFIK_*`) e o log do Traefik |
| Entra na sala, mas sem áudio e vídeo | As portas `7881/tcp` e `7882/udp` no firewall e no provedor, `SERVER_PUBLIC_IP` e `DOCKER_BRIDGE_SUBNET` |
| O assistente não entra | O agente precisa estar completo (selo "configuração incompleta" no painel) e marcado na sala; veja `docker service logs impameet_agent` |
| O assistente entra, mas não fala | A chave do Fish Audio, o ID da voz e o crédito na conta; teste a integração no painel |
| A gravação não começa | `docker service logs impameet_egress` e a CPU livre (cerca de 1,5 núcleo por gravação) |

Logs de cada serviço: `docker service logs -f impameet_<serviço>`.
