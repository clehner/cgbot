/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import {connect as xmppConnect} from './xmpp.js';
import {connect as ircConnect} from './irc.js';
import {log, getLogUrl} from './log.js';
import ltxSerialize from 'ltx/lib/stringify';
import process from 'process';
import {processCommand} from './command.js';
import {v4 as uuidv4} from 'uuid';
import {xml} from '@xmpp/client';

export async function manage({meeting, meetings, xmppOptions}) {
  const xmppClient = xmppConnect(xmppOptions);
  const {ircOptions} = meetings[meeting];
  const ircClient = ircConnect(ircOptions);
  const participants = {};
  const logFileBasePath = `${ircOptions.log}-${meeting}`;
  let announcedPresence = false;

  xmppClient.on('online', async address => {
    if(xmppOptions.debug) {
      console.log('XMPP MANAGE online as', address.toString());
    }
    await _joinXmppMuc({meeting, xmppClient});
  });

  // handle channel join event
  ircClient.on('join', function(channel, nick) {
    if(nick !== nick) {
      return;
    } else {
      if(ircOptions.debug) {
        console.log('IRC joined', ircOptions.server, channel, 'as', nick);
      }
    }

    // listen to IRC channel messages
    const ircSay = ircClient.say.bind(ircClient, channel);

    xmppClient.on('stanza', async stanza => {
      if(xmppOptions.debug) {
        console.log('\n' + ltxSerialize(stanza, 2) + '\n');
      }

      // presence information (joining and leaving the audio bridge)
      if(stanza.is('presence')) {
        const beforeCount = Object.keys(participants).length;
        if(stanza.attrs.type === 'unavailable') {
          const from = stanza.attrs.from;
          const participant = participants[from];
          if(participant) {
            ircSay(participant.name + ' left the meeting.');
            delete participants[from];
          }
        } else if(stanza.getChild('nick')) {
          const from = stanza.attrs.from;
          const name = stanza.getChild('nick').text();
          const participant = {id: from, name, handUp: false};
          if(participants[from] === undefined) {
            participants[from] = participant;
            ircSay(participant.name + ' joined the meeting.');

            // Announce that cgbot is here if it hasn't already done so
            if(!announcedPresence) {
              const logUrl =
                getLogUrl({logFileBasePath, logUrl: ircOptions.logUrl});
              const info = `Logging to ${logUrl}`;
              ircSay(info);
              xmppSay({info, meeting, xmppClient});
              announcedPresence = true;
            }
          }
        }

        // clean up if we're the last ones left
        const afterCount = Object.keys(participants).length;
        if(afterCount === 1 && beforeCount > 1) {
          ircSay('The meeting has ended.');
          process.kill(process.pid, 'SIGINT');
        }
      }

      // handle XMPP-based queueing by raising hand
      if(stanza.is('presence') &&
        stanza.getChild('jitsi_participant_raisedHand')) {
        const from = stanza.attrs.from;
        const participant = participants[from];
        const nick = stanza.getChild('nick').text().replace(/ /g, '_');
        const handUp =
          stanza.getChild('jitsi_participant_raisedHand').text() === 'true';
        if(participant) {
          if(!participant.handUp && handUp) {
            const message = 'q+';
            processCommand(
              {nick, message, participants, say: async message => {
                ircSay(message);
                await xmppSay({info: message, meeting, xmppClient});
              }});
          } else if(participant.handUp && !handUp) {
            const message = 'q-';
            processCommand(
              {nick, message, participants, say: async message => {
                ircSay(message);
                await xmppSay({info: message, meeting, xmppClient});
              }});
          }
          participants[from].handUp = handUp;
        }
      }

      // group chat message
      if(stanza.attrs.type === 'groupchat') {
        if(stanza.getChild('nick')) {
          const nick = stanza.getChild('nick').text().replace(/ /g, '_');
          const message = stanza.getChild('body').text();
          const replay = (stanza.getChild('delay')) ? true : false;
          if(nick !== 'CG_Bot' && !replay) {
            // log XMPP messages to logfile
            if(ircOptions.log) {
              log({logFileBasePath, nick, message});
            }

            ircSay(`${nick}: ${message}`);
            processCommand({nick, message, participants, say: async message => {
              ircSay(message);
              await xmppSay({info: message, meeting, xmppClient});
            }});
          }
        }
      }
    });

    ircClient.on('message' + channel, async (nick, message) => {
      // log IRC messages to logfile if a recording log prefix is specified
      if(ircOptions.log) {
        log({logFileBasePath, nick, message});
      }

      // echo from IRC to XMPP
      await xmppSay({info: `${nick}: ${message}`, meeting, xmppClient});
      processCommand({nick, message, participants, say: async message => {
        ircSay(message);
        await xmppSay({info: message, meeting, xmppClient});
      }});
    });

    // start the XMPP client once all handlers are setup
    xmppClient.start().catch(console.error);
  });
}

async function _joinXmppMuc({meeting, xmppClient}) {
  const xmppMessage = xml(
    'presence',
    {
      from: xmppClient.jid.toString(),
      id: uuidv4(),
      to: `${meeting}@conference.${xmppClient.jid._domain}/cgbot`
    },
    xml('nick', 'http://jabber.org/protocol/nick', 'CG Bot'),
    xml('x', 'http://jabber.org/protocol/muc')
  );

  await xmppClient.send(xmppMessage);
}

async function xmppSay({info, meeting, xmppClient}) {
  const xmppMessage = xml(
    'message',
    {
      from: xmppClient.jid.toString(),
      id: uuidv4(),
      to: `${meeting}@conference.${xmppClient.jid._domain}`,
      type: 'groupchat'
    },
    xml('nick', 'http://jabber.org/protocol/nick', 'CG Bot'),
    xml('body', {}, info)
  );

  await xmppClient.send(xmppMessage);
}