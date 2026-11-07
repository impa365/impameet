# Como contribuir

Obrigado por querer melhorar o IMPA Meet! Correções, novas funções, traduções e documentação
são bem-vindas.

## Antes de começar

- Para mudanças grandes, abra uma **issue** primeiro e combine a abordagem.
- Falhas de segurança **não** vão em issue pública: siga o [SECURITY.md](SECURITY.md).
- Ao contribuir, você concorda que a sua contribuição é licenciada sob a
  [Licença Apache 2.0](LICENSE), como o resto do projeto.

## Fluxo

1. Faça um fork e crie uma branch a partir de `main` (`feat/minha-funcao`, `fix/meu-ajuste`).
2. Escreva o código **com testes**.
3. Rode a bateria do app que você mudou:

   ```bash
   docker build --target test apps/platform   # ou apps/agent, apps/screen
   ```

4. Abra o pull request descrevendo o que muda e como testar. A CI precisa passar.

## Padrões do projeto

- **Sem segredos no código**: nada de chaves, tokens, IPs ou domínios reais em arquivos,
  testes ou exemplos. Use `example.com` e valores fictícios. A CI roda o gitleaks.
- **Sem provedor, modelo ou voz padrão**: tudo o que o agente usa é escolhido no painel.
- **Textos da interface em três idiomas**: toda mensagem nova entra em
  `apps/platform/src/i18n/messages` em português, inglês e espanhol.
- **Acessibilidade**: componentes novos precisam funcionar só com o teclado e com leitor de
  tela.
- **Desempenho**: nada de bibliotecas pesadas para resolver o que algumas linhas resolvem.
- Python com `ruff`, `mypy` (strict) e `bandit`; TypeScript com `eslint`, `prettier` e `tsc`.
- Commits curtos e no imperativo, de preferência no formato
  [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`...).

## Créditos

Arquivos derivados do projeto precisam manter os avisos de copyright e o arquivo
[`NOTICE`](NOTICE), conforme a licença.
