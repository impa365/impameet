# Política de segurança

## Como relatar uma vulnerabilidade

**Não abra uma issue pública.** Relate de forma privada por um destes canais:

- **GitHub:** aba *Security* → *Report a vulnerability* (aviso privado de segurança);
- **E-mail:** [contato@impa365.com](mailto:contato@impa365.com), com o assunto
  `[SEGURANÇA] IMPA Meet`.

Inclua a versão ou o commit, os passos para reproduzir e o impacto esperado. Respondemos em
até 5 dias úteis e combinamos com você a data de divulgação depois da correção.

## Versões com suporte

Apenas a versão mais recente (branch `main` e a última tag `v*`) recebe correções de
segurança.

## Boas práticas de instalação

- Crie os segredos com `deploy/scripts/prepare.sh`, que nunca mostra nem grava valores.
- Inclua `/var/lib/docker/swarm` nos backups: é lá que fica a chave que criptografa as chaves
  dos provedores.
- Fixe a versão das imagens em produção (`IMPAMEET_VERSION`) e acompanhe as releases.
- Libere no firewall só as portas `80`, `443`, `7881/tcp` e `7882/udp`.
