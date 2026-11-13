import { defineMessages } from '../define';

export default defineMessages(
  {
    on: 'ligado',
    off: 'desligado',
    blocked: 'bloqueado pelo navegador',
    howItWorks:
      'Vou fazer algumas perguntas e ouvir as suas respostas. Você também pode usar os botões, o teclado ou digitar, a qualquer momento. Para mudar o microfone ou a câmera, diga, por exemplo: “{name}, desliga meu microfone”.',
    askName: 'Qual é o seu nome?',
    askConfirmName: 'Entendi que o seu nome é {name}. Está correto? Diga sim ou não.',
    askMicrophone: 'O seu microfone está {state}. Diga manter, ligar ou desligar.',
    askCamera: 'A sua câmera está {state}. Diga manter, ligar ou desligar.',
    askJoin: 'Microfone {microphone}, câmera {camera}. Posso entrar na sala agora? Diga sim ou não.',
    microphoneIs: 'Microfone {state}.',
    cameraIs: 'Câmera {state}.',
    notUnderstood: 'Não entendi o nome.',
    sayYesOrNo: 'Não entendi. Responda sim ou não.',
    sayOnOffKeep: 'Não entendi, e não mudei nada.',
    noSpeech: 'Não ouvi nada.',
    letsTryAgain: 'Tudo bem, vamos de novo.',
    review: 'Tudo bem, não vou entrar ainda. Vamos revisar.',
    confirmNameFirst: 'Antes de entrar, preciso confirmar o seu nome.',
    commandUnknown: 'Não entendi o comando. Diga, por exemplo: “{name}, liga minha câmera”.',
    paused:
      'Pausei a conversa porque não consegui entender. Use os botões, ou aperte “Retomar conversa” para tentar de novo.',
    pausedByYou: 'Conversa pausada. Aperte “Retomar conversa” quando quiser.',
    recognitionFailed:
      'O reconhecimento de fala parou de funcionar. Use os botões, ou aperte “Retomar conversa” para tentar de novo.',
    pause: 'Pausar conversa',
    resume: 'Retomar conversa',
    repeatQuestion: 'Repetir a pergunta',
    typeName: 'Ou digite o seu nome',
    sayNameAgain: 'Dizer o nome de novo',
    commandsHint:
      'Por voz, a qualquer momento: “{name}, liga/desliga meu microfone” ou “{name}, liga/desliga minha câmera”.',
    nothingToRepeat: 'Ainda não falei nada para repetir.',
    alreadyIn: 'Você já está na sala.',
    cannotPublish: 'Nesta reunião você não tem permissão para ligar o microfone ou a câmera.',
    deviceBlocked:
      'Não consegui mudar: o navegador bloqueou o dispositivo. Libere no cadeado ao lado do endereço do site.',
    listeningBlocked:
      'O navegador não deixou ouvir os comandos de voz. Libere o microfone no cadeado ao lado do endereço do site.',
    unsupported: 'Este navegador não reconhece fala. Os comandos de voz funcionam no Chrome, Edge e Safari.',
    settingsTitle: 'Assistente de voz',
    enable: 'Ouvir comandos de voz durante a reunião',
    enableHelp:
      'O navegador fica ouvindo só para reconhecer comandos que começam pelo nome do assistente. O reconhecimento é feito pelo navegador, que pode usar um serviço do fabricante (Google, Apple ou Microsoft). O IMPA Meet não grava nem guarda o áudio nem os comandos.',
    wakeWordLabel: 'Nome do assistente',
    wakeWordHelp: 'Escolha uma palavra curta que você não costuma dizer na conversa.',
    examples:
      'Exemplos: “{name}, desliga meu microfone”, “{name}, liga minha câmera”, “{name}, meu microfone está ligado?”, “{name}, repete”.',
    chip: '{name} ouvindo',
  },
  {
    en: {
      on: 'on',
      off: 'off',
      blocked: 'blocked by the browser',
      howItWorks:
        'I will ask a few questions and listen to your answers. You can also use the buttons, the keyboard or type, at any time. To change the microphone or camera, say for example: “{name}, turn off my microphone”.',
      askName: 'What is your name?',
      askConfirmName: 'I understood your name is {name}. Is that correct? Say yes or no.',
      askMicrophone: 'Your microphone is {state}. Say keep, turn on or turn off.',
      askCamera: 'Your camera is {state}. Say keep, turn on or turn off.',
      askJoin: 'Microphone {microphone}, camera {camera}. Can I join the room now? Say yes or no.',
      microphoneIs: 'Microphone {state}.',
      cameraIs: 'Camera {state}.',
      notUnderstood: 'I did not catch the name.',
      sayYesOrNo: 'I did not understand. Please answer yes or no.',
      sayOnOffKeep: 'I did not understand, and changed nothing.',
      noSpeech: 'I did not hear anything.',
      letsTryAgain: 'All right, let us try again.',
      review: 'All right, I will not join yet. Let us review.',
      confirmNameFirst: 'Before joining, I need to confirm your name.',
      commandUnknown: 'I did not understand the command. Say for example: “{name}, turn on my camera”.',
      paused:
        'I paused the conversation because I could not understand. Use the buttons, or press “Resume conversation” to try again.',
      pausedByYou: 'Conversation paused. Press “Resume conversation” whenever you want.',
      recognitionFailed:
        'Speech recognition stopped working. Use the buttons, or press “Resume conversation” to try again.',
      pause: 'Pause conversation',
      resume: 'Resume conversation',
      repeatQuestion: 'Repeat the question',
      typeName: 'Or type your name',
      sayNameAgain: 'Say my name again',
      commandsHint:
        'By voice, at any time: “{name}, turn on/off my microphone” or “{name}, turn on/off my camera”.',
      nothingToRepeat: 'I have not said anything to repeat yet.',
      alreadyIn: 'You are already in the room.',
      cannotPublish: 'In this meeting you are not allowed to turn on the microphone or camera.',
      deviceBlocked:
        'I could not change it: the browser blocked the device. Allow it in the padlock next to the site address.',
      listeningBlocked:
        'The browser did not allow listening for voice commands. Allow the microphone in the padlock next to the site address.',
      unsupported: 'This browser does not recognize speech. Voice commands work in Chrome, Edge and Safari.',
      settingsTitle: 'Voice assistant',
      enable: 'Listen for voice commands during the meeting',
      enableHelp:
        'The browser listens only to recognize commands that start with the assistant’s name. Recognition is done by the browser, which may use its vendor’s service (Google, Apple or Microsoft). IMPA Meet never records or keeps the audio or the commands.',
      wakeWordLabel: 'Assistant name',
      wakeWordHelp: 'Pick a short word you do not usually say in conversation.',
      examples:
        'Examples: “{name}, turn off my microphone”, “{name}, turn on my camera”, “{name}, is my microphone on?”, “{name}, repeat”.',
      chip: '{name} listening',
    },
    es: {
      on: 'encendido',
      off: 'apagado',
      blocked: 'bloqueado por el navegador',
      howItWorks:
        'Te haré algunas preguntas y escucharé tus respuestas. También puedes usar los botones, el teclado o escribir, en cualquier momento. Para cambiar el micrófono o la cámara, di por ejemplo: “{name}, apaga mi micrófono”.',
      askName: '¿Cuál es tu nombre?',
      askConfirmName: 'Entendí que tu nombre es {name}. ¿Es correcto? Di sí o no.',
      askMicrophone: 'Tu micrófono está {state}. Di mantener, encender o apagar.',
      askCamera: 'Tu cámara está {state}. Di mantener, encender o apagar.',
      askJoin: 'Micrófono {microphone}, cámara {camera}. ¿Puedo entrar a la sala ahora? Di sí o no.',
      microphoneIs: 'Micrófono {state}.',
      cameraIs: 'Cámara {state}.',
      notUnderstood: 'No entendí el nombre.',
      sayYesOrNo: 'No entendí. Responde sí o no.',
      sayOnOffKeep: 'No entendí, y no cambié nada.',
      noSpeech: 'No escuché nada.',
      letsTryAgain: 'Muy bien, otra vez.',
      review: 'Muy bien, todavía no entro. Revisemos.',
      confirmNameFirst: 'Antes de entrar, necesito confirmar tu nombre.',
      commandUnknown: 'No entendí la orden. Di por ejemplo: “{name}, enciende mi cámara”.',
      paused:
        'Pausé la conversación porque no pude entender. Usa los botones, o pulsa “Reanudar conversación” para intentarlo de nuevo.',
      pausedByYou: 'Conversación en pausa. Pulsa “Reanudar conversación” cuando quieras.',
      recognitionFailed:
        'El reconocimiento de voz dejó de funcionar. Usa los botones, o pulsa “Reanudar conversación” para intentarlo de nuevo.',
      pause: 'Pausar conversación',
      resume: 'Reanudar conversación',
      repeatQuestion: 'Repetir la pregunta',
      typeName: 'O escribe tu nombre',
      sayNameAgain: 'Decir mi nombre otra vez',
      commandsHint:
        'Por voz, en cualquier momento: “{name}, enciende/apaga mi micrófono” o “{name}, enciende/apaga mi cámara”.',
      nothingToRepeat: 'Todavía no dije nada que repetir.',
      alreadyIn: 'Ya estás en la sala.',
      cannotPublish: 'En esta reunión no tienes permiso para encender el micrófono o la cámara.',
      deviceBlocked:
        'No pude cambiarlo: el navegador bloqueó el dispositivo. Permítelo en el candado junto a la dirección del sitio.',
      listeningBlocked:
        'El navegador no permitió escuchar las órdenes de voz. Permite el micrófono en el candado junto a la dirección del sitio.',
      unsupported: 'Este navegador no reconoce voz. Las órdenes de voz funcionan en Chrome, Edge y Safari.',
      settingsTitle: 'Asistente de voz',
      enable: 'Escuchar órdenes de voz durante la reunión',
      enableHelp:
        'El navegador escucha solo para reconocer órdenes que empiezan con el nombre del asistente. El reconocimiento lo hace el navegador, que puede usar un servicio del fabricante (Google, Apple o Microsoft). IMPA Meet nunca graba ni guarda el audio ni las órdenes.',
      wakeWordLabel: 'Nombre del asistente',
      wakeWordHelp: 'Elige una palabra corta que no sueles decir en la conversación.',
      examples:
        'Ejemplos: “{name}, apaga mi micrófono”, “{name}, enciende mi cámara”, “{name}, ¿mi micrófono está encendido?”, “{name}, repite”.',
      chip: '{name} escuchando',
    },
  },
);
