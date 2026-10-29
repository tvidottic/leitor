# Leitor — PDF, anotações gravadas no arquivo e tradução contextual

Aplicativo web instalável (PWA) para ler livros e arquivos PDF em desktop, notebook e tablet, com foco em quem
estuda outro idioma. É “clean” por escolha: uma barra enxuta, um painel lateral e um painel de tradução. O que
importa fica a um toque; o resto está no menu “⋯”.

- **Anotações no padrão PDF:** destaques, sublinhados, riscados, notas e traços de caneta são gravados dentro do
  próprio arquivo como anotações PDF (Highlight, Underline, StrikeOut, Ink), com aparência embutida. Abrem no
  Acrobat, Chrome, Edge, Firefox, Preview (Mac), Apple Livros, Xodo, Foxit e em qualquer leitor que siga a norma.
- **Arquivo original sempre atualizado:** abra um PDF vinculado ao arquivo do disco (inclusive em pastas sincronizadas
  do OneDrive, Google Drive, iCloud ou Dropbox) ou direto do Google Drive / Dropbox, e as anotações são salvas no
  mesmo arquivo, automaticamente, poucos segundos após cada alteração.
- **Tradução por seleção e tradução contextual com IA:** o diferencial para estudo de idiomas (detalhes abaixo).

## Onde usar

Versão publicada (instalável em celular e tablet): **https://tvidottic.github.io/leitor/**

O site entrega apenas o código do aplicativo. Livros, anotações, vocabulário e chaves ficam no navegador de cada aparelho; nada é enviado ao GitHub. Para o Google Drive e o Dropbox, use esse endereço nas origens/redirects autorizados (Dropbox: com a barra final).

## Como executar localmente

Requisito: Python 3. Não há dependências nem etapa de build.

- **Windows:** dê dois cliques em `iniciar.bat`.
- **Qualquer sistema:**

```bash
python serve.py 8787
```

Abra `http://localhost:8787`. Para usar em tablets e outros aparelhos, publique a pasta em qualquer hospedagem
estática com HTTPS (GitHub Pages, Netlify, Vercel, Cloudflare Pages) ou sirva na rede local. HTTPS é necessário para
instalar como aplicativo e para o login nas nuvens (exceto em `localhost`).

### Instalação como aplicativo

| Dispositivo | Como instalar | Observações |
|---|---|---|
| Windows / macOS / Linux (Chrome, Edge) | Ícone “Instalar” na barra de endereço | Suporte completo, inclusive arquivos vinculados no disco |
| macOS (Safari 17+) | Arquivo → Adicionar ao Dock | Sem arquivos vinculados; use Drive/Dropbox ou baixe o PDF anotado |
| iPad / iPhone (Safari) | Compartilhar → Adicionar à Tela de Início | Idem; Drive e Dropbox funcionam |
| Android (Chrome, Samsung Internet) | Menu → Instalar aplicativo | Idem; Drive e Dropbox funcionam |
| Firefox (desktop) | Usa no navegador (sem instalação) | Tudo funciona, exceto arquivos vinculados |

Depois de instalado o aplicativo abre offline (os livros ficam no armazenamento do navegador); só as traduções e a
nuvem precisam de internet.

## Por que este formato (compatibilidade e perenidade)

- **Web padrão, sem frameworks nem build.** HTML, CSS e JavaScript puros, com duas bibliotecas consolidadas e
  embutidas (pdf.js, da Mozilla, e pdf-lib). Nada para compilar ou atualizar; o mesmo código roda em todos os
  sistemas e navegadores modernos, hoje e daqui a anos.
- **Seus dados em formatos abertos.** As anotações vivem dentro do PDF (norma ISO 32000); o vocabulário exporta em
  CSV (Anki); há backup em JSON de anotações, marcadores e vocabulário. Nada fica preso ao aplicativo.
- **Sem servidor próprio.** Os arquivos ficam no seu dispositivo e nas suas nuvens; as chaves de API e as credenciais
  OAuth ficam só no navegador.

## Funcionalidades

**Biblioteca** — importação por arraste ou pelo menu “Abrir PDF” (dispositivo, arquivo vinculado, Google Drive,
Dropbox); capa, progresso, tempo de leitura, renomear, baixar o PDF anotado, vincular/desvincular. O arquivo de
origem é reverificado ao abrir: se foi anotado em outro aplicativo, a versão nova é carregada e as anotações
importadas.

**Leitura** — rolagem contínua ou **página a página** (uma página por vez: deslize para o lado ou toque nas bordas para virar, duplo toque amplia, e com “Travar zoom e enquadramento” a página seguinte abre no mesmo zoom e posição), zoom por largura/página/
porcentagem, pinça no tablet, Ctrl+roda no desktop, **cortar margens** (detecta a área útil da página, ideal em
tablets), **girar**, miniaturas, sumário com links clicáveis do próprio PDF, marcadores de página, busca no documento,
histórico de navegação (botão “voltar” após saltos), **tela cheia imersiva** (barra oculta; aparece ao passar o
mouse no topo ou tocar na página), temas claro/escuro/sépia e modo noturno das páginas, **leitura em voz alta** da
página com continuação automática.

**Anotações** — 4 cores de destaque, sublinhado, riscado, nota de texto, **caneta** (4 cores, 3 espessuras, borracha,
opção “só caneta” para ignorar o dedo no tablet). Toque em uma anotação para recolorir, anotar, traduzir ou excluir.
Lista lateral, exportação em Markdown. Tudo gravado no PDF com o nome de autor configurado.

**Tradução** — popup instantâneo ao selecionar (Google Tradutor, com alternativas), **modo toque** (um clique na
palavra), painel com dicionário em inglês (classes gramaticais, definições, fonética, áudio), “Traduzir a frase
inteira” (localiza a frase na página e traduz com o trecho destacado), **Wikipédia** para nomes e conceitos, link
para o Google Tradutor, página traduzida parágrafo a parágrafo, vocabulário com cartões de revisão e CSV para Anki.

**Tradução contextual com IA (Claude)** — com uma chave da API da Anthropic, “Explicar no contexto” envia o trecho
com o parágrafo ao redor e devolve, em streaming, uma tradução fiel e notas sobre expressões idiomáticas, gírias,
referências culturais e históricas, jogos de palavras, falsos cognatos e gramática, ajustadas ao nível do leitor.
A explicação pode ser salva como nota do destaque (e vai para o PDF).

## Anotações no PDF: como funciona

1. Ao anotar, o registro é salvo no aplicativo imediatamente.
2. Alguns segundos depois, um processo em segundo plano regrava o PDF com todas as anotações de marcação
   (as suas e as já existentes), cada uma com aparência própria (`/AP`), cor, autor, data e o texto da nota em
   `/Contents`. O indicador ao lado do título mostra “Não salvo → Salvando… → Salvo”.
3. Se o livro estiver vinculado a um arquivo (disco ou nuvem), o arquivo é sobrescrito com a nova versão.
4. Ao abrir o PDF, as anotações presentes no arquivo (feitas aqui ou em outro programa) são importadas e passam a
   ser editáveis. Excluir ou recolorir uma delas aqui também altera o arquivo.

Limitações: PDFs protegidos por senha não são regravados (as anotações ficam só no aplicativo); anotações de outros
tipos (carimbos, texto livre, formulários) são preservadas no arquivo, mas não editadas.

## Nuvem

**Sem configuração (recomendado no desktop):** instale o cliente do OneDrive, Google Drive, Dropbox ou iCloud e
abra o PDF pela opção “Do dispositivo, vinculado ao arquivo”. O Leitor grava no arquivo e o cliente sincroniza.

**Google Drive (qualquer dispositivo):** é preciso criar um ID de cliente OAuth gratuito, uma única vez.

1. Acesse [console.cloud.google.com](https://console.cloud.google.com), crie um projeto e, em “APIs e serviços →
   Biblioteca”, ative a **Google Drive API**.
2. Em “Tela de consentimento OAuth”, escolha “Externo”, preencha nome e e-mail e adicione o seu e-mail em “Usuários
   de teste” (o app pode ficar em modo de teste; não precisa de verificação do Google para uso pessoal).
3. Em “Credenciais → Criar credenciais → ID do cliente OAuth”, tipo **Aplicativo da Web**, adicione em “Origens
   JavaScript autorizadas” o endereço onde o Leitor roda (ex.: `http://localhost:8787` e o endereço HTTPS em que você
   publicou). Copie o ID (termina em `.apps.googleusercontent.com`) e cole em Configurações → Nuvem.
4. Em “Abrir PDF → Google Drive”, entre com sua conta e escolha o arquivo.

**Dropbox:** crie um app em [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) (Scoped access,
Full Dropbox, permissões `files.metadata.read`, `files.content.read` e `files.content.write`). Em “Redirect URIs”,
adicione o endereço do Leitor com barra final (ex.: `http://localhost:8787/`). Cole a **App key** em
Configurações → Nuvem. O login usa OAuth PKCE, sem segredo do app.

## No celular e no tablet

- Toque no centro da página para esconder ou mostrar a barra; um indicador discreto mostra a página atual.
- A seleção de texto é do próprio Leitor, não a do navegador: toque e segure uma palavra, arraste para estender (palavras inteiras) e ajuste pelas alças. Por isso não aparecem os menus de copiar/pesquisar do navegador. As opções surgem numa barra na base da tela ao soltar o dedo. No computador, a seleção nativa continua (dá para forçar a própria do app em Configurações → Seleção de texto, útil no Edge). A tradução automática pode ser desligada no menu “⋯”.
- Tela cheia fica na barra principal; no iPhone e iPad, que não têm tela cheia no navegador, o botão esconde a barra.
- Modo página a página: deslize para o lado, toque nas bordas ou use o duplo toque para ampliar. O zoom e o enquadramento se mantêm ao virar a página.
- A tela fica ligada durante a leitura (pode desativar nas configurações).
- **Tablet em paisagem:** o modo página a página mostra duas páginas lado a lado, como um livro aberto (desligável no menu “⋯”). No paginado também é possível usar o zoom “Largura”.
- **Caneta (Apple Pencil, S Pen e similares):** seleciona texto arrastando, sem toque longo, e, na ferramenta de caneta, escreve enquanto o dedo rola a página (“Só caneta” liga sozinho ao detectar a caneta).
- **Barra de progresso:** controle deslizante de páginas na base da tela, com percentual e estimativa de tempo restante calculada pelo seu ritmo de leitura.
- **Desfazer:** Ctrl+Z, botão na barra da caneta ou menu “⋯” desfaz a última anotação criada, excluída ou alterada.

## Atalhos de teclado

| Tecla | Ação |
|---|---|
| ← → / PageUp PageDown / Espaço | Página anterior / próxima |
| + − / Ctrl+0 | Zoom / ajustar à largura |
| Alt+← | Voltar à posição anterior (após sumário, busca, link) |
| S | Barra lateral |
| T | Traduzir seleção (ou abrir/fechar painel) |
| C | Explicar seleção no contexto (IA) |
| H / U / 1-4 | Destacar / sublinhar / destacar com a cor 1 a 4 |
| N | Nota na seleção (sem seleção: modo noturno) |
| V | Salvar seleção no vocabulário |
| P | Caneta |
| B | Marcar página |
| W | Modo toque (tradução por clique na palavra) |
| Ctrl+F | Buscar no documento |
| F | Tela cheia imersiva |
| Esc | Fechar menus / limpar seleção |

## Estrutura

```
index.html                Interface (biblioteca, leitor, painéis, diálogos)
css/app.css               Estilos, temas e layout responsivo
js/app.js                 Inicialização, navegação, configurações, backup, PWA
js/library.js             Biblioteca: importação (dispositivo, vinculado, nuvem), capas, origem
js/viewer.js              Visualizador PDF (pdf.js): virtualização, zoom, rotação, corte, links, busca
js/annotations.js         Destaques, sublinhados, riscados, notas e caneta (coordenadas PDF); importação do PDF
js/pdf-writer.worker.js   Worker que grava as anotações no PDF (pdf-lib) com aparência embutida
js/pdfsync.js             Sincronização automática: PDF do app → arquivo vinculado / nuvem
js/cloud.js               Google Drive e Dropbox (OAuth no navegador) e seletor de arquivos
js/ink.js                 Ferramenta de caneta
js/reader.js              Tela de leitura: barra, lateral, seleção, marcadores, histórico, voz, imersivo
js/panel.js               Painel de tradução (Google, dicionário, contexto, IA, Wikipédia)
js/translate.js           Serviços: Google Tradutor, dicionário, Claude (streaming)
js/vocab.js               Vocabulário e exportação CSV
js/db.js                  IndexedDB (livros, arquivos, anotações, vocabulário, cache)
js/vendor/                pdf.js 4.10.38 e pdf-lib 1.17.1 (locais, funcionam offline)
sw.js                     Service worker (uso offline)
serve.py / iniciar.bat    Servidor local
exemplos/                 PDF de exemplo com expressões idiomáticas em inglês
```

## Privacidade

- Livros, anotações, vocabulário, configurações e credenciais ficam apenas no navegador.
- Ao traduzir, o trecho (e, na tradução contextual, o parágrafo ao redor) é enviado ao serviço escolhido: Google
  Tradutor, Free Dictionary API, Wikipédia ou API da Anthropic. Na nuvem, o arquivo vai e volta diretamente entre o
  navegador e o Google Drive / Dropbox.

## Limitações conhecidas

- PDFs digitalizados sem camada de texto (imagens) não permitem seleção, tradução nem destaque de texto; a caneta e
  as notas funcionam. Seria preciso OCR.
- O endpoint público do Google Tradutor não é oficial e pode limitar uso intenso; há um serviço de reserva
  (MyMemory) para trechos curtos.
- EPUB ainda não é suportado; converta para PDF (Calibre).
- Arquivos vinculados no disco exigem Chrome ou Edge no desktop (API File System Access). Nos demais, use nuvem ou
  “Baixar PDF com anotações”.
