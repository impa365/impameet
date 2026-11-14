import { defineMessages } from '../define';

export default defineMessages(
  {
    title: 'Google Agenda',
    intro:
      'Conecte a sua agenda: as reuniões que você agendar aqui entram no seu Google Agenda com o link da sala, e o Google envia o convite para os convidados. Cancelar aqui cancela lá.',
    connectedAs: 'Conectado como {email} desde {date}.',
    unavailable: 'O super admin ainda não configurou o Google nesta plataforma.',
    connect: 'Conectar Google Agenda',
    connecting: 'Abrindo o Google…',
    reconnect: 'Conectar de novo',
    disconnect: 'Desconectar',
    disconnectConfirm:
      'Desconectar o Google Agenda? As próximas reuniões não vão mais para a sua agenda. As que já estão lá continuam.',
    disconnected: 'Google Agenda desconectado.',
    couldNotConnect: 'Não foi possível concluir. Tente de novo.',
    privacy:
      'A plataforma só cria e cancela os eventos das reuniões que você agendar aqui. Ela não lê os seus outros compromissos. O acesso fica criptografado e é revogado no Google quando você desconecta.',
    statusConnected: 'Google Agenda conectado.',
    statusCancelled: 'Conexão com o Google Agenda cancelada.',
    statusError: 'Não foi possível conectar o Google Agenda. Tente de novo.',
    statusScope:
      'O Google não deu a permissão da agenda. Na tela do Google, marque a opção de ver e editar eventos e tente de novo.',
    scheduledSynced:
      'A reunião também entrou no seu Google Agenda, e o Google enviou o convite aos convidados.',
    scheduledFailed: 'Não foi possível colocar a reunião no seu Google Agenda: {error}',
    formConnected: 'Esta reunião também vai para o seu Google Agenda.',
    formNotConnected: 'Quer que as reuniões entrem no seu Google Agenda?',
    formConnectLink: 'Conecte em Minha conta.',
    badge: 'No Google Agenda',
    badgeFailed: 'Fora do Google Agenda',
  },
  {
    en: {
      title: 'Google Calendar',
      intro:
        'Connect your calendar: meetings you schedule here go into your Google Calendar with the room link, and Google sends the invitation to the guests. Cancelling here cancels there.',
      connectedAs: 'Connected as {email} since {date}.',
      unavailable: 'The super admin has not set up Google on this platform yet.',
      connect: 'Connect Google Calendar',
      connecting: 'Opening Google…',
      reconnect: 'Connect again',
      disconnect: 'Disconnect',
      disconnectConfirm:
        'Disconnect Google Calendar? Upcoming meetings will no longer go to your calendar. Those already there stay.',
      disconnected: 'Google Calendar disconnected.',
      couldNotConnect: 'Could not finish. Try again.',
      privacy:
        'The platform only creates and cancels the events of meetings you schedule here. It does not read your other appointments. Access is encrypted and revoked at Google when you disconnect.',
      statusConnected: 'Google Calendar connected.',
      statusCancelled: 'Google Calendar connection cancelled.',
      statusError: 'Could not connect Google Calendar. Try again.',
      statusScope:
        'Google did not grant the calendar permission. On Google’s screen, tick the option to view and edit events and try again.',
      scheduledSynced:
        'The meeting is also in your Google Calendar, and Google sent the invitation to the guests.',
      scheduledFailed: 'Could not put the meeting in your Google Calendar: {error}',
      formConnected: 'This meeting also goes to your Google Calendar.',
      formNotConnected: 'Want meetings in your Google Calendar?',
      formConnectLink: 'Connect it in My account.',
      badge: 'In Google Calendar',
      badgeFailed: 'Not in Google Calendar',
    },
    es: {
      title: 'Google Calendar',
      intro:
        'Conecta tu calendario: las reuniones que programes aquí entran en tu Google Calendar con el enlace de la sala, y Google envía la invitación a los invitados. Cancelar aquí cancela allá.',
      connectedAs: 'Conectado como {email} desde el {date}.',
      unavailable: 'El super admin aún no configuró Google en esta plataforma.',
      connect: 'Conectar Google Calendar',
      connecting: 'Abriendo Google…',
      reconnect: 'Conectar de nuevo',
      disconnect: 'Desconectar',
      disconnectConfirm:
        '¿Desconectar Google Calendar? Las próximas reuniones ya no irán a tu calendario. Las que ya están allí se quedan.',
      disconnected: 'Google Calendar desconectado.',
      couldNotConnect: 'No se pudo terminar. Inténtalo de nuevo.',
      privacy:
        'La plataforma solo crea y cancela los eventos de las reuniones que programes aquí. No lee tus otros compromisos. El acceso queda cifrado y se revoca en Google cuando desconectas.',
      statusConnected: 'Google Calendar conectado.',
      statusCancelled: 'Conexión con Google Calendar cancelada.',
      statusError: 'No se pudo conectar Google Calendar. Inténtalo de nuevo.',
      statusScope:
        'Google no dio el permiso del calendario. En la pantalla de Google, marca la opción de ver y editar eventos e inténtalo de nuevo.',
      scheduledSynced:
        'La reunión también entró en tu Google Calendar, y Google envió la invitación a los invitados.',
      scheduledFailed: 'No se pudo poner la reunión en tu Google Calendar: {error}',
      formConnected: 'Esta reunión también va a tu Google Calendar.',
      formNotConnected: '¿Quieres que las reuniones entren en tu Google Calendar?',
      formConnectLink: 'Conéctalo en Mi cuenta.',
      badge: 'En Google Calendar',
      badgeFailed: 'Fuera de Google Calendar',
    },
  },
);
