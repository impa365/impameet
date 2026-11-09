# Quadro branco acessível: como funciona e roteiro de testes manuais

O quadro (Excalidraw) é uma imagem desenhada num canvas, e leitores de tela não conseguem lê-la. Por isso,
cada quadro aberto vem com uma **descrição em texto** completa, montada a partir dos dados dos elementos
(nada de OCR):

- **"Descrição do quadro em texto: N elementos":** um bloco expansível (`<details>`) logo abaixo do quadro,
  ligado à região do quadro por `aria-describedby`.
- **Lista de elementos** em ordem de leitura (de cima para baixo, da esquerda para a direita). Cada item é
  uma frase: tipo, texto, descrição, o que a seta liga, posição e quem fez. Exemplo: *"Seta, liga “Vendas” a
  elipse, no centro, por Ana"*.
- **Navegação:** só um item fica na ordem do Tab. As setas para cima e para baixo, Home e End passam de um
  item a outro. As atualizações não tiram o foco do lugar, porque cada item tem uma chave estável.
- **Sem descrição:** imagens, desenhos à mão livre e conteúdo incorporado aparecem como *"(sem descrição)"*.
  Quem pode desenhar tem o botão **Descrever**, e a descrição é sincronizada para todos (fica em
  `customData.alt` do elemento).
- **Alterações recentes:** lista com horário e autor, por exemplo *"Bia escreveu “Meta”"*.
- **Avisos** em `aria-live="polite"`, que nunca tiram o foco. A pessoa escolhe em **Acessibilidade → Avisos
  do quadro branco**:
  - *Cada alteração:* agrupa as alterações em alguns segundos.
  - *Só um resumo:* no máximo a cada 30 segundos. É o padrão.
  - *Não avisar.*

  Traços de desenho livre nunca são anunciados ponto a ponto.

A autoria só é conhecida para o que foi desenhado depois que a pessoa entrou. Elementos que já existiam
aparecem sem autor.

## Testes automatizados

- `tests/unit/board-text.test.ts`: transformação dos elementos em texto, posições, setas, descrições,
  alterações, agrupamento dos avisos, preferências e a semântica ARIA do componente (nome, instruções,
  item único na ordem do Tab, rótulos dos botões, lista de alterações).

## Roteiro manual (repetir a cada mudança no quadro)

Prepare uma sala com duas pessoas. A pessoa A desenha um retângulo com o texto "Vendas", uma elipse, uma
seta ligando os dois e um desenho à mão livre. A pessoa B usa o leitor de tela.

### NVDA + Firefox ou Chrome (Windows)

1. Abra o quadro. Com Tab, chegue em "Descrição do quadro em texto". O NVDA deve dizer *"recolhido"*. Abra
   com Enter: deve dizer *"expandido"*.
2. Tab entra na lista. O NVDA deve ler o nome *"Elementos do quadro"* e as instruções.
3. Seta para baixo e para cima: cada item lido inteiro, numa frase só. Home e End vão ao primeiro e ao
   último.
4. Peça para A escrever um texto novo. Com *"Cada alteração"*, o NVDA fala *"Quadro branco: Ana escreveu
   …"* depois de uns 3 segundos, **sem** mover o foco nem interromper a leitura.
5. Mude para *"Não avisar"* e confirme que nada é dito. A lista continua atualizada.
6. Como quem pode desenhar: em *"Desenho à mão livre (sem descrição)"*, use **Descrever**, escreva "Estrela"
   e confirme que A vê a mesma descrição.

### VoiceOver + Safari (macOS e iOS)

1. macOS: VO + setas até "Descrição do quadro em texto". VO + espaço abre. Na lista, VO + setas lê cada item.
2. iOS: deslize até o resumo, toque duas vezes para abrir e deslize item por item. A exploração por toque
   sobre a lista lê o item tocado.
3. Repita os passos 4 e 5 do NVDA.

### TalkBack + Chrome (Android)

1. Deslize até o resumo, toque duas vezes para abrir e percorra os itens deslizando.
2. Confirme que os avisos (passo 4) não interrompem a leitura em andamento.

### Visual e teclado (WCAG 2.2 AA)

- O foco fica visível (contorno de 3 px) no resumo, nos itens e nos botões.
- O contraste do texto da lista e das alterações é de pelo menos 4,5:1, no tema claro e no escuro.
- Com zoom de 200%, a lista rola dentro do bloco, sem esconder conteúdo.
