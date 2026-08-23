# Screen Share App

App simples de compartilhamento de tela entre 2 pessoas, usando WebRTC (conexão peer-to-peer) com um servidor Node.js só para sinalização.

## Como rodar

Backend em [NestJS](https://nestjs.com/) (TypeScript) + WebSocket (`ws`), frontend estático sem build (`public/`).

```bash
cd screen-share-app
npm install
npm run start:dev   # desenvolvimento, com recarregamento automático
```

Ou pra rodar como em produção:

```bash
npm run build
npm start
```

O servidor sobe em `http://localhost:3000`.

## Como testar (localmente, entre 2 abas)

1. Abra `http://localhost:3000` em duas abas (ou dois navegadores).
2. Em ambas, digite o **mesmo código de sala** (ex: `sala-123`) e clique em "Entrar na sala".
3. Em uma das abas, clique em "Compartilhar minha tela" e escolha a tela/janela.
4. A outra aba deve exibir o vídeo (e áudio, se disponível) compartilhado.

### Sobre o compartilhamento de áudio

O app pede áudio junto com o vídeo, mas o navegador só disponibiliza essa opção dependendo do que você escolhe compartilhar:

| O que você compartilha | Áudio disponível? |
|---|---|
| Uma aba do Chrome/Edge | Sim (marque "Compartilhar áudio da guia") |
| Tela inteira | Depende do SO — no Windows geralmente sim ("Compartilhar áudio do sistema"), no macOS geralmente não sem software adicional |
| Uma janela de aplicativo específica | Normalmente não |

Se a pessoa não marcar a opção de áudio na hora de escolher o que compartilhar, só o vídeo será enviado.

## Testar com outra pessoa (rede diferente)

Como o servidor de sinalização só troca metadados (não o vídeo), ele precisa estar acessível pela internet para duas pessoas em redes diferentes se conectarem. Algumas opções:

- Hospedar em um serviço como Render, Railway ou Fly.io (grátis para testes, e já servem HTTPS/WSS automaticamente — necessário pro `getDisplayMedia` funcionar fora do `localhost`).
- Usar `ngrok` para expor o `localhost:3000` temporariamente: `ngrok http 3000`.

### Servidor TURN (opcional)

Por padrão o app usa só o **STUN** público do Google, que funciona na maioria das redes domésticas. Em redes corporativas com firewall restritivo isso não é suficiente — nesse caso, configure um **TURN** via variáveis de ambiente (nenhuma credencial fica no código):

```bash
TURN_URL=turn:seu-turn.exemplo.com:3478
TURN_USERNAME=usuario
TURN_CREDENTIAL=senha
```

`TURN_URL` aceita várias URLs separadas por vírgula (ex: `turn:host:3478,turns:host:5349` pra oferecer UDP e TLS). Opções pra conseguir um TURN: rodar o [coturn](https://github.com/coturn/coturn) você mesmo, ou usar um serviço gerenciado como [Twilio](https://www.twilio.com/docs/stun-turn) ou [Xirsys](https://xirsys.com/). Se as variáveis não forem definidas, o app continua funcionando normalmente só com STUN.

### Senha por sala (opcional)

O código da sala sozinho funciona como uma senha fraca (quem souber o código entra). Pra mais segurança, quem cria a sala pode definir uma senha no campo "Senha da sala" ao entrar pela primeira vez — depois disso, todo mundo que quiser entrar nessa sala precisa da mesma senha. Salas protegidas aparecem com 🔒 na lista de salas ativas. Deixar o campo em branco mantém a sala sem senha (comportamento padrão, igual antes).

### Rate limiting

O servidor limita, por IP: no máximo 30 conexões WebSocket novas por minuto, e no máximo 200 mensagens de sinalização a cada 10 segundos por conexão. Isso evita que uma pessoa mal-intencionada (ou um cliente com bug) sobrecarregue o servidor ou spamme criação de salas. Atrás de um proxy (Render, Railway, Fly.io, nginx...) o servidor usa o header `X-Forwarded-For` pra identificar o IP real de quem conecta.

## Estrutura

```
screen-share-app/
├── src/                        # Backend (NestJS)
│   ├── main.ts                 # bootstrap + WsAdapter
│   ├── app.module.ts
│   ├── rooms/                  # estado das salas, senha e gateway WebSocket
│   ├── rate-limiter/           # limite de conexões/mensagens por IP
│   └── ice-servers/            # GET /ice-servers (STUN + TURN via env)
├── package.json
└── public/                     # Frontend estático (servido pelo Nest)
    ├── index.html
    ├── client.js                # Lógica WebRTC + captura de tela
    └── style.css
```

## Como funciona (resumo)

1. Cada navegador se conecta ao servidor via WebSocket e entra em uma "sala" (só um código de texto).
2. Quando alguém clica em "Compartilhar tela", o navegador usa `getDisplayMedia()` para capturar a tela.
3. É criada uma `RTCPeerConnection`, e a negociação (offer/answer/ICE candidates) é trocada através do servidor WebSocket.
4. Depois da negociação, o vídeo passa a fluir **direto entre os dois navegadores** (peer-to-peer) — o servidor não vê o conteúdo da tela.
