// ===== Elementos da interface =====
const joinPanel = document.getElementById('join-panel');
const roomPanel = document.getElementById('room-panel');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const passwordInput = document.getElementById('password-input');
const joinBtn = document.getElementById('join-btn');
const roomsListEl = document.getElementById('rooms-list');
const micBtn = document.getElementById('mic-btn');
const shareBtn = document.getElementById('share-btn');
const stopShareBtn = document.getElementById('stop-share-btn');
const participantsList = document.getElementById('participants-list');
const participantsCount = document.getElementById('participants-count');
const voiceAudioSink = document.getElementById('voice-audio-sink');
const leaveBtn = document.getElementById('leave-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const screenVideo = document.getElementById('screen-video');
const screenHint = document.getElementById('screen-hint');
const screenLabel = document.getElementById('screen-label');
const videoToolbar = document.getElementById('video-toolbar');
const fullscreenBtn = document.getElementById('fullscreen-btn');

// ===== Estado da aplicação =====
let ws = null;
let localStream = null;
let audioContext = null;
let processedAudioTrack = null; // áudio da tela já filtrado (sem ruído), o que de fato mandamos pra rede
let roomCode = null;
let myPassword = '';
let myId = null;
let myName = 'Você';
let pendingJoin = false; // true enquanto esperamos o WebSocket abrir pra entrar na sala

// Nomes de todo mundo na sala (inclusive eu), por id.
const peerNames = new Map();

// Uma RTCPeerConnection de TELA por peer com quem estou falando: se eu
// estiver apresentando, uma pra cada espectador; se eu estiver assistindo,
// só uma (com quem está apresentando agora). Separada das conexões de voz
// porque as duas ligam/desligam em momentos completamente diferentes.
const screenPeerConnections = new Map();

// Quem está apresentando a sala agora (só uma pessoa por vez).
let presenterId = null;
let presenterName = null;
let remoteStream = null;

// ===== Voice chat (malha de áudio entre todo mundo da sala) =====
// Uma RTCPeerConnection de VOZ por peer, criada assim que alguém entra na
// sala (independente de ligar o microfone) — assim dá pra já ouvir quem
// ligar o microfone depois, sem precisar renegociar a conexão. Cada entrada
// guarda o "sender" de áudio: ligar/desligar o microfone só troca a track
// desse sender (RTCRtpSender.replaceTrack), sem nova oferta/resposta.
const voicePeers = new Map(); // peerId -> { pc, sender, audioEl }
let micStream = null;
let micEnabled = false;

// Pra uma malha (todo mundo conecta com todo mundo) sem duplicar conexões,
// só quem tem o id "menor" inicia a oferta pro outro lado — o outro espera.
function shouldInitiateVoiceTo(otherPeerId) {
  return myId < otherPeerId;
}

// Quem está sendo exibido na única tela disponível agora: 'local', 'remote' ou null.
let activeSharer = null;
let screenHintText = 'Aguardando alguém compartilhar a tela...';

// Servidores ICE: STUN público do Google como base, mais um TURN se o
// servidor tiver um configurado (variáveis de ambiente TURN_URL/
// TURN_USERNAME/TURN_CREDENTIAL) — necessário pra funcionar atrás de
// firewalls corporativos onde STUN sozinho não é suficiente.
let iceServersConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

fetch('/ice-servers')
  .then((res) => res.json())
  .then((data) => {
    if (data && Array.isArray(data.iceServers)) {
      iceServersConfig = data;
    }
  })
  .catch((err) => console.error('Não foi possível buscar os servidores ICE:', err));

// ===== Conexão com o servidor =====
// Conectamos assim que a página carrega (não só ao clicar em "Entrar"),
// pra já recebermos a lista de salas ativas antes do usuário decidir.
connectWebSocket();

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    if (pendingJoin) {
      pendingJoin = false;
      sendJoin();
    }
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);
    await handleSignal(msg);
  });

  ws.addEventListener('close', () => {
    setStatus(false, 'Desconectado do servidor');
  });

  ws.addEventListener('error', () => {
    setStatus(false, 'Erro de conexão');
  });
}

// ===== Entrar na sala =====
joinBtn.addEventListener('click', () => {
  const code = roomInput.value.trim();
  const name = nameInput.value.trim();
  if (!name) {
    alert('Digite seu nome.');
    return;
  }
  if (!code) {
    alert('Digite um código de sala.');
    return;
  }
  myName = name;
  roomCode = code;
  myPassword = passwordInput.value;

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendJoin();
  } else {
    // O WebSocket ainda não abriu (ou caiu) — marca pra entrar assim
    // que a conexão (re)abrir, e tenta reconectar se necessário.
    pendingJoin = true;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }
  }
});

function sendJoin() {
  // Não trocamos de painel aqui: esperamos a confirmação do servidor
  // ('joined' ou 'join-denied', se a senha estiver errada).
  ws.send(JSON.stringify({ type: 'join', room: roomCode, name: myName, password: myPassword }));
  setStatus(true, `Entrando na sala "${roomCode}"...`);
}

function setStatus(connected, text) {
  statusDot.classList.toggle('connected', connected);
  statusText.textContent = text;
}

// ===== Lista de salas ativas =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderRoomList(rooms) {
  if (!rooms || rooms.length === 0) {
    roomsListEl.innerHTML = '<div class="rooms-empty">Nenhuma sala ativa no momento.</div>';
    return;
  }

  const title = '<div class="rooms-list-title">Salas ativas</div>';
  const items = rooms.map((r) => {
    const safeRoom = escapeHtml(r.room);
    const label = r.count === 1 ? '1 pessoa' : `${r.count} pessoas`;
    const lock = r.hasPassword ? '🔒 ' : '';
    return `<div class="room-item" data-room="${safeRoom}"><span>${lock}${safeRoom}</span><span class="room-count">${label}</span></div>`;
  }).join('');

  roomsListEl.innerHTML = title + items;

  roomsListEl.querySelectorAll('.room-item').forEach((el) => {
    el.addEventListener('click', () => {
      roomInput.value = el.dataset.room;
    });
  });
}

// ===== Lista de participantes da sala (sempre visível, na lateral) =====
// Quem eu sei que está com o microfone ligado agora (id -> true), a partir
// dos avisos 'mic-changed' — só pra mostrar o indicador na lista.
const micActivePeers = new Set();

function renderParticipants() {
  participantsCount.textContent = peerNames.size;

  if (peerNames.size === 0) {
    participantsList.innerHTML = '<div class="participants-empty">Ninguém mais por aqui ainda.</div>';
    return;
  }

  participantsList.innerHTML = Array.from(peerNames.entries()).map(([id, name]) => {
    const isPresenting = id === presenterId;
    const isMicOn = id === myId ? micEnabled : micActivePeers.has(id);
    const label = id === myId ? `${name} (você)` : name;
    const cls = isPresenting ? 'participant-item presenting' : 'participant-item';
    const mic = isMicOn ? '<span title="Microfone ligado">🎤</span>' : '';
    const badge = isPresenting ? '<span class="participant-badge">apresentando</span>' : '';
    return `<div class="${cls}"><span>${escapeHtml(label)}</span>${mic}${badge}</div>`;
  }).join('');
}

// ===== Tela cheia =====
// Qualquer um dos dois (quem compartilha ou quem assiste) pode expandir
// o vídeo pra tela cheia usando a Fullscreen API nativa do navegador.
fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    screenVideo.requestFullscreen().catch((err) => {
      console.error('Erro ao entrar em tela cheia:', err);
    });
  }
});

// ===== Tela única (mostra sempre quem está apresentando) =====
function renderScreen() {
  if (activeSharer === 'local' && localStream) {
    screenVideo.srcObject = localStream;
    screenVideo.muted = true; // evita eco do seu próprio áudio
    screenLabel.textContent = `Você (${myName})`;
    screenVideo.style.display = 'block';
    screenLabel.style.display = 'block';
    screenHint.style.display = 'none';
    videoToolbar.style.display = 'flex';
  } else if (activeSharer === 'remote' && remoteStream) {
    screenVideo.srcObject = remoteStream;
    screenVideo.muted = false;
    screenLabel.textContent = presenterName || 'Convidado';
    screenVideo.style.display = 'block';
    screenLabel.style.display = 'block';
    screenHint.style.display = 'none';
    videoToolbar.style.display = 'flex';
  } else {
    screenVideo.srcObject = null;
    screenVideo.style.display = 'none';
    screenLabel.style.display = 'none';
    screenHint.style.display = 'flex';
    screenHint.textContent = screenHintText;
    videoToolbar.style.display = 'none';
  }
}

// ===== Botão de compartilhar: reflete se dá pra apresentar agora =====
function updateShareControls() {
  if (activeSharer === 'local') {
    shareBtn.style.display = 'none';
    stopShareBtn.style.display = 'inline-block';
    stopShareBtn.disabled = false;
  } else if (presenterId) {
    // Outra pessoa está apresentando agora.
    shareBtn.style.display = 'inline-block';
    shareBtn.disabled = true;
    shareBtn.title = `${presenterName || 'Alguém'} já está compartilhando a tela`;
    stopShareBtn.style.display = 'none';
  } else {
    shareBtn.style.display = 'inline-block';
    shareBtn.disabled = false;
    shareBtn.title = '';
    stopShareBtn.style.display = 'none';
  }
}

// ===== Conexões WebRTC de tela (uma por peer) =====
function createScreenPeerConnection(peerId) {
  const connection = new RTCPeerConnection(iceServersConfig);

  // Sempre que o navegador encontra um novo "caminho de rede" possível
  // (candidate), manda pro peer correspondente via WebSocket.
  connection.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice-candidate', purpose: 'screen', candidate: event.candidate, target: peerId }));
    }
  };

  // Quando o stream desse peer chega, ele passa a ser exibido na tela única
  // (esse peer é quem está apresentando agora).
  connection.ontrack = (event) => {
    remoteStream = event.streams[0];
    activeSharer = 'remote';
    renderScreen();
    updateShareControls();
  };

  connection.onconnectionstatechange = () => {
    console.log(`Estado da conexão de TELA com ${peerId}:`, connection.connectionState);
  };

  screenPeerConnections.set(peerId, connection);
  return connection;
}

function closeScreenPeerConnection(peerId) {
  const connection = screenPeerConnections.get(peerId);
  if (connection) {
    connection.close();
    screenPeerConnections.delete(peerId);
  }
}

function closeAllScreenPeerConnections() {
  screenPeerConnections.forEach((connection) => connection.close());
  screenPeerConnections.clear();
}

// ===== Cancelamento de ruído do áudio compartilhado =====
// As opções echoCancellation/noiseSuppression pedidas no getDisplayMedia
// (lá embaixo) valem pra microfone, mas o navegador costuma ignorá-las pra
// áudio de aba/tela/sistema. Então filtramos esse áudio "na mão" com a Web
// Audio API antes de mandar pra rede: um passa-alta corta zumbido/ruído
// grave constante (ventoinha, hum de energia) e um compressor suaviza picos
// e reduz a percepção de ruído de fundo baixo e constante.
function setupNoiseSuppression(stream) {
  const rawAudioTrack = stream.getAudioTracks()[0];
  if (!rawAudioTrack) return;

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(new MediaStream([rawAudioTrack]));

  const highpass = audioContext.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 100;

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -50;
  compressor.knee.value = 30;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.2;

  const destination = audioContext.createMediaStreamDestination();
  source.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(destination);

  processedAudioTrack = destination.stream.getAudioTracks()[0];
}

function teardownNoiseSuppression() {
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  processedAudioTrack = null;
}

// Vídeo original + áudio já filtrado (se houver) — é isso que mandamos
// pra cada espectador, em vez do áudio bruto capturado da tela.
function getOutgoingTracks() {
  const tracks = localStream.getVideoTracks();
  if (processedAudioTrack) {
    tracks.push(processedAudioTrack);
  } else {
    tracks.push(...localStream.getAudioTracks());
  }
  return tracks;
}

// Cria uma conexão + oferta de TELA dedicada pra um espectador específico.
// Usada quando eu começo a apresentar e quando alguém novo entra na sala
// enquanto eu já estou apresentando.
async function offerScreenTo(peerId) {
  closeScreenPeerConnection(peerId);
  const pc = createScreenPeerConnection(peerId);
  getOutgoingTracks().forEach((track) => pc.addTrack(track, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', purpose: 'screen', offer, target: peerId }));
}

// ===== Conexões WebRTC de voz (malha entre todo mundo) =====
// Cria (sem oferecer ainda) a conexão de voz com um peer: monta o
// transceiver de áudio bidirecional, o elemento <audio> que vai tocar o que
// a gente receber dele, e guarda tudo em voicePeers.
function setupVoicePeerConnection(peerId) {
  const pc = new RTCPeerConnection(iceServersConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice-candidate', purpose: 'voice', candidate: event.candidate, target: peerId }));
    }
  };

  pc.ontrack = (event) => {
    let audioEl = voicePeers.get(peerId)?.audioEl;
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      voiceAudioSink.appendChild(audioEl);
    }
    audioEl.srcObject = event.streams[0];
    const entry = voicePeers.get(peerId);
    if (entry) entry.audioEl = audioEl;
  };

  pc.onconnectionstatechange = () => {
    console.log(`Estado da conexão de VOZ com ${peerId}:`, pc.connectionState);
  };

  voicePeers.set(peerId, { pc, sender: null, audioEl: null });
  return pc;
}

// Eu inicio a conexão de voz com esse peer (sou o lado com id "menor").
async function offerVoiceTo(peerId) {
  const pc = setupVoicePeerConnection(peerId);
  const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  voicePeers.get(peerId).sender = transceiver.sender;
  if (micStream) {
    await transceiver.sender.replaceTrack(micStream.getAudioTracks()[0]);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', purpose: 'voice', offer, target: peerId }));
}

// Recebi uma oferta de voz de alguém com id "menor" que o meu — respondo.
async function handleVoiceOffer(senderId, offer) {
  const pc = setupVoicePeerConnection(senderId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));

  const transceiver = pc.getTransceivers()[0];
  voicePeers.get(senderId).sender = transceiver.sender;
  if (micStream) {
    await transceiver.sender.replaceTrack(micStream.getAudioTracks()[0]);
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', purpose: 'voice', answer, target: senderId }));
}

function closeVoicePeer(peerId) {
  const entry = voicePeers.get(peerId);
  if (!entry) return;
  entry.pc.close();
  if (entry.audioEl) {
    entry.audioEl.srcObject = null;
    entry.audioEl.remove();
  }
  voicePeers.delete(peerId);
}

function closeAllVoicePeers() {
  Array.from(voicePeers.keys()).forEach(closeVoicePeer);
}

// Liga/desliga meu microfone em TODAS as conexões de voz já abertas, sem
// precisar renegociar nenhuma delas (RTCRtpSender.replaceTrack).
function updateMicButton() {
  micBtn.classList.toggle('active', micEnabled);
  micBtn.textContent = micEnabled ? '🎤 Desativar microfone' : '🎤 Ativar microfone';
}

micBtn.addEventListener('click', async () => {
  if (micEnabled) {
    micEnabled = false;
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
    voicePeers.forEach(({ sender }) => sender && sender.replaceTrack(null));
    updateMicButton();
    renderParticipants();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'mic-changed', enabled: false }));
    }
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    micEnabled = true;
    const micTrack = micStream.getAudioTracks()[0];
    voicePeers.forEach(({ sender }) => sender && sender.replaceTrack(micTrack));
    updateMicButton();
    renderParticipants();
    ws.send(JSON.stringify({ type: 'mic-changed', enabled: true }));
  } catch (err) {
    console.error('Erro ao ativar microfone:', err);
    alert('Não foi possível acessar o microfone.');
  }
});

// ===== Tratamento das mensagens de sinalização vindas do servidor =====
async function handleSignal(msg) {
  switch (msg.type) {
    case 'room-list':
      renderRoomList(msg.rooms);
      break;

    case 'joined':
      myId = msg.id;
      peerNames.clear();
      (msg.peers || []).forEach((p) => peerNames.set(p.id, p.name));
      peerNames.set(myId, myName);
      if (msg.presenter) {
        presenterId = msg.presenter.id;
        presenterName = msg.presenter.name;
        screenHintText = `${presenterName} está compartilhando a tela. Conectando...`;
      }
      joinPanel.style.display = 'none';
      roomPanel.style.display = 'flex';
      setStatus(true, `Conectado à sala "${roomCode}"`);
      updateShareControls();
      renderScreen();
      renderParticipants();
      // Conecta a malha de voz com quem já estava na sala (só quem tem o id
      // "menor" inicia, o outro lado responde quando a oferta chegar).
      Array.from(peerNames.keys())
        .filter((id) => id !== myId && shouldInitiateVoiceTo(id))
        .forEach((id) => offerVoiceTo(id));
      break;

    case 'join-denied':
      setStatus(false, 'Não foi possível entrar na sala');
      if (msg.reason === 'wrong-password') {
        alert('Senha incorreta para essa sala.');
        passwordInput.focus();
      } else {
        alert('Não foi possível entrar na sala.');
      }
      break;

    case 'peer-joined':
      peerNames.set(msg.id, msg.name);
      renderParticipants();
      // Se eu já estou apresentando, essa pessoa não recebeu a oferta
      // original (ela só é enviada pra quem já estava na sala). Então
      // abrimos uma conexão dedicada pra ela também poder ver a transmissão.
      if (activeSharer === 'local' && localStream) {
        offerScreenTo(msg.id);
      }
      // O mesmo vale pra voz: se eu tenho o id "menor", inicio a conexão
      // com quem acabou de chegar (ela vai me ouvir e eu vou ouvi-la assim
      // que algum dos dois ligar o microfone).
      if (shouldInitiateVoiceTo(msg.id)) {
        offerVoiceTo(msg.id);
      }
      break;

    case 'peer-left':
      peerNames.delete(msg.id);
      closeScreenPeerConnection(msg.id);
      closeVoicePeer(msg.id);
      micActivePeers.delete(msg.id);
      renderParticipants();
      break;

    case 'presenter-changed':
      if (msg.presenterId) {
        presenterId = msg.presenterId;
        presenterName = msg.presenterName || peerNames.get(msg.presenterId) || 'Convidado';
        if (presenterId === myId) {
          // O servidor confirmou que ganhei a disputa por virar apresentador.
          // Só agora abrimos uma conexão dedicada com cada outra pessoa da sala.
          activeSharer = 'local';
          renderScreen();
          const otherPeerIds = Array.from(peerNames.keys()).filter((id) => id !== myId);
          otherPeerIds.forEach((id) => offerScreenTo(id));
        } else {
          screenHintText = `${presenterName} está compartilhando a tela. Conectando...`;
        }
      } else {
        // O apresentador parou (ou saiu da sala).
        const whoStopped = presenterId === myId ? 'Você' : (presenterName || 'A outra pessoa');
        if (presenterId && presenterId !== myId) {
          closeScreenPeerConnection(presenterId);
          remoteStream = null;
        }
        presenterId = null;
        presenterName = null;
        // Vale tanto pra quem estava assistindo ('remote') quanto pra quem
        // era a própria apresentadora e acabou de parar ('local').
        activeSharer = null;
        screenHintText = `${whoStopped} parou de compartilhar a tela.`;
        renderScreen();
      }
      updateShareControls();
      renderParticipants();
      break;

    case 'offer': {
      if (msg.purpose === 'voice') {
        await handleVoiceOffer(msg.senderId, msg.offer);
        break;
      }
      const pc = createScreenPeerConnection(msg.senderId);
      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', purpose: 'screen', answer, target: msg.senderId }));
      break;
    }

    case 'answer': {
      if (msg.purpose === 'voice') {
        const entry = voicePeers.get(msg.senderId);
        if (entry) await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        break;
      }
      const pc = screenPeerConnections.get(msg.senderId);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
      break;
    }

    case 'ice-candidate': {
      const pc = msg.purpose === 'voice'
        ? voicePeers.get(msg.senderId)?.pc
        : screenPeerConnections.get(msg.senderId);
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (err) {
          console.error('Erro ao adicionar ICE candidate:', err);
        }
      }
      break;
    }

    case 'mic-changed':
      if (msg.enabled) {
        micActivePeers.add(msg.id);
      } else {
        micActivePeers.delete(msg.id);
      }
      renderParticipants();
      break;

    case 'presenting-denied':
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
      }
      teardownNoiseSuppression();
      alert(`${msg.presenterName || 'Outra pessoa'} já está compartilhando a tela nessa sala.`);
      updateShareControls();
      break;
  }
}

// ===== Compartilhar tela =====
shareBtn.addEventListener('click', async () => {
  if (presenterId) return; // outra pessoa já está apresentando

  try {
    // Abre o seletor nativo do sistema operacional para escolher
    // tela inteira, janela específica ou aba do navegador.
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      // Pede áudio junto com o vídeo. O navegador só oferece essa opção
      // quando o usuário escolhe compartilhar uma ABA ou a TELA INTEIRA
      // (com "Compartilhar áudio do sistema" marcado) — não aparece ao
      // escolher uma janela de aplicativo específica.
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    setupNoiseSuppression(localStream);

    // Pede ao servidor pra virar o apresentador da sala. Só criamos as
    // conexões com os outros peers quando a confirmação ('presenter-changed'
    // com o nosso id) chegar — se alguém ganhar essa corrida antes de nós,
    // o servidor responde 'presenting-denied' e desfazemos a captura.
    ws.send(JSON.stringify({ type: 'presenting-start' }));

    // Se o usuário parar o compartilhamento pelo painel nativo do navegador
    // (botão "Parar compartilhamento" que o Chrome/Firefox mostram), detectamos aqui.
    localStream.getVideoTracks()[0].addEventListener('ended', stopSharing);
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      console.error('Erro ao compartilhar tela:', err);
      alert('Não foi possível iniciar o compartilhamento de tela.');
    }
  }
});

stopShareBtn.addEventListener('click', stopSharing);

function stopSharing() {
  const wasPresenting = activeSharer === 'local';

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  teardownNoiseSuppression();
  closeAllScreenPeerConnections();

  // Não mexemos em presenterId/activeSharer/hint aqui: o servidor ecoa
  // 'presenter-changed' (com presenterId: null) de volta pra gente também,
  // e é esse evento que atualiza o estado — assim evitamos ficar fora de
  // sincronia caso as duas coisas aconteçam em momentos diferentes.
  if (wasPresenting) {
    ws.send(JSON.stringify({ type: 'presenting-stop' }));
  }
  updateShareControls();
}

// ===== Sair da sala =====
leaveBtn.addEventListener('click', () => {
  stopSharing();
  closeAllScreenPeerConnections();

  // Desliga o microfone e derruba toda a malha de voz.
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  micEnabled = false;
  updateMicButton();
  closeAllVoicePeers();
  micActivePeers.clear();

  // Fecha e reabre o WebSocket pra voltar ao modo "lobby" (recebendo
  // a lista de salas de novo), em vez de deixar sem conexão nenhuma.
  if (ws) {
    ws.close();
    ws = null;
  }
  connectWebSocket();

  roomPanel.style.display = 'none';
  joinPanel.style.display = 'flex';
  roomInput.value = '';
  passwordInput.value = '';
  myPassword = '';
  peerNames.clear();
  renderParticipants();
  myId = null;
  presenterId = null;
  presenterName = null;
  remoteStream = null;
  activeSharer = null;
  screenHintText = 'Aguardando alguém compartilhar a tela...';
  renderScreen();
  updateShareControls();
});
