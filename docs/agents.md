# Assistentes de IA: o que podem fazer, quem autoriza e os limites

Tudo o que um assistente pode fazer além de conversar fica **desligado até um administrador ligar**, em
**Administração → Agentes → editar**. Em cada sala, os moderadores ainda podem desligar tudo durante a
reunião em **Configurações da sala → "A IA pode agir e observar nesta sala"**. O efeito é imediato e
vale também para as salas paralelas.

## Moderação

| Ação | Quem pode pedir | Regras do administrador valem? |
| --- | --- | --- |
| Remover participante | Moderador presente na chamada | Sim |
| Silenciar microfone | Moderador presente na chamada | Sim |
| Responder à sala de espera | Moderador presente na chamada | Sim |
| Desligar câmera | Só moderador presente na chamada | **Não** |
| Iniciar / parar gravação | Só moderador presente na chamada | **Não** |

- A IA **nunca** age sobre moderadores, o dono da sala, administradores, gestores ou outros assistentes.
- Antes de **remover** alguém, ela pergunta em voz alta e só remove se o **mesmo moderador** que pediu
  disser "sim" em até 90 segundos. O "sim" de outra pessoa não vale.
- No máximo 10 ações a cada 10 minutos, por agente e por sala.
- Tudo vai para a auditoria com `via: ai`, o nome do agente, quem pediu e a regra aplicada.
- A gravação pela IA vale só para a sala principal e segue as mesmas regras de uma gravação feita por
  pessoas: plano com gravação, uma gravação por vez por sala e tratamento de falhas do Egress.

## O que a IA pode ver

Liga-se por agente: **quadro branco**, **enquetes** e **telas compartilhadas**.

- A IA só olha **quando alguém pede** ("Kaiser, o que tem no quadro?") e diz de quem é o conteúdo.
- **Quadro:** a IA recebe os mesmos dados que os navegadores e ignora desenhos de quem não pode desenhar na
  sala (por exemplo, quando só moderadores desenham).
- **Enquetes:** a IA sabe a pergunta e quantos votos cada opção tem, **nunca** em quem cada pessoa votou.
- **Telas:** a IA captura **um quadro da tela no momento do pedido** e envia ao modelo de linguagem escolhido
  para o agente.

**Consentimento e retenção.** Ao ligar "telas compartilhadas", o administrador aceita que imagens da
reunião sejam enviadas ao provedor do modelo de linguagem do agente. A plataforma **não guarda** imagens,
texto do quadro nem resultados de enquetes. A imagem fica só na conversa da IA até a próxima substituí-la,
e tudo se perde quando a reunião acaba. Quem compartilha a tela continua vendo o indicador de
compartilhamento normal, e a IA diz em voz alta quando olhou.

## Ferramentas externas (HTTP e MCP)

Em **editar agente → Ferramentas externas**, o administrador cadastra:

- **Chamada HTTP:** método, URL (com `{{parametro}}` no caminho ou na consulta), parâmetros que a IA
  preenche (texto, número, número inteiro, sim/não), modelo de corpo JSON opcional e cabeçalhos.
- **Servidor MCP remoto** (Streamable HTTP): URL, cabeçalhos e quais ferramentas do servidor a IA pode usar.
  **Nenhuma** fica liberada até ser marcada. Servidores locais (stdio) não são aceitos, porque rodariam
  programas no servidor da plataforma.

### Quem pode mandar a IA usar uma ferramenta

- **Convidados nunca podem**, nem se forem promovidos a moderador na sala.
- "Só moderadores" (padrão): o dono da sala, administradores e gestores da organização, ou um membro com
  login que está moderando a chamada.
- "Membros": qualquer membro **com login e ativo** da organização.
- Quem pediu é sempre quem **falou** no turno, identificado pelo LiveKit. A IA não pode escolher nem
  inventar quem pediu. Se alguém sem permissão falou no mesmo turno, a ferramenta não roda.
- **Confirmação** (ligada por padrão): a IA diz o que vai fazer e só executa depois do "sim" da mesma pessoa.

### Segurança

- Quem faz a chamada é **o servidor da plataforma**. As chaves (cabeçalhos) ficam criptografadas com
  AES-256-GCM e nunca chegam ao agente de voz nem voltam a aparecer no painel.
- Proteção contra SSRF: só `https://` em endereços **públicos**. O endereço é conferido também **na hora de
  conectar**, o que bloqueia DNS rebinding. Redirecionamentos não são seguidos.
- Limites: tempo máximo de 1 a 30 segundos, resposta de até 512 KB, e a IA recebe no máximo 4.000
  caracteres. São no máximo 30 chamadas a cada 10 minutos por agente e sala, e 10 por minuto por ferramenta.
- O resultado vai para a IA marcado como **dados externos**, e ela é instruída a nunca seguir instruções
  que venham dentro dele (proteção contra prompt injection).
- Auditoria: `agent.tool` com a ferramenta, quem pediu, se deu certo, o status HTTP e o tempo. Os argumentos
  e o resultado não são gravados, porque podem conter dados pessoais.

### Serviços internos (n8n, APIs na mesma rede)

Por padrão, endereços internos são recusados. O responsável pelo servidor pode liberar **nomes**
específicos (aceitam http e https):

```env
AGENT_TOOLS_PRIVATE_HOSTS=n8n,crm-api
```

## Segurança dos papéis na sala

Desde a versão 1.2, os participantes **não conseguem mais alterar os próprios atributos** no LiveKit
(papel, nome, mão levantada). Antes, um convidado com conhecimento técnico podia se declarar
"moderador". Levantar a mão agora passa pelo servidor, que confere o token de entrada assinado e se a
pessoa está mesmo na sala.
