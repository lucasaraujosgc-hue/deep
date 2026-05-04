import React, { useState, useEffect, useRef } from 'react';
import { 
  Building2, CheckCircle2, Clock, AlertCircle, Loader2, Bot, Power, User, Trash2,
  Plus, MoreHorizontal, MessageCircle, Settings, X, Search, Phone, Send, Mic, 
  Paperclip, Music, FileText, Image as ImageIcon, RefreshCw, History, Download
} from 'lucide-react';
import { UserSettings, WaKanbanState, WaKanbanColumn, WaKanbanTag, WaKanbanCard } from '../types';
import { api } from '../services/api';
import ReactMarkdown from 'react-markdown';

interface Props {
  userSettings: UserSettings;
  onSaveSettings: (s: UserSettings) => void;
}

const Dashboard: React.FC<Props> = ({ userSettings, onSaveSettings }) => {
  const [loading, setLoading] = useState(true);
  const [waChats, setWaChats] = useState<any[]>([]);
  const [contactNumber, setContactNumber] = useState('');
  
  // Modals
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [activeChat, setActiveChat] = useState<any | null>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [newMessageText, setNewMessageText] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<File | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [transcribingMap, setTranscribingMap] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [tagMenuCardId, setTagMenuCardId] = useState<string | null>(null);
  const [chatDetailsMap, setChatDetailsMap] = useState<Record<string, { profilePicUrl?: string | null, lastMessage?: string, lastMessageFromMe?: boolean, name?: string, number?: string | null }>>({});
  const [expandedMediaUrl, setExpandedMediaUrl] = useState<string | null>(null);
  const [expandedMediaType, setExpandedMediaType] = useState<'image' | 'video' | 'document' | null>(null);
  const [syncStatus, setSyncStatus] = useState<Record<string, { synced: boolean; lastSync: number | null; messageCount: number }>>({});
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState<Record<string, boolean>>({});

  const kanbanState: WaKanbanState = userSettings.waKanban || { columns: [], tags: [], cards: [] };

  const loadWaChats = async () => {
    try {
      const chats = await api.getWhatsAppChats();
      setWaChats(chats);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const activeChatRef = useRef(activeChat);
  useEffect(() => {
      activeChatRef.current = activeChat;
  }, [activeChat]);

  // SSE Handler corrigido
  useEffect(() => {
    loadWaChats();

    const token = localStorage.getItem('cm_auth_token');
    const es = new EventSource(`/api/whatsapp/events?token=${token}`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'whatsapp_message') {
          const msg = data.payload;
          const chatId = msg.fromMe ? msg.to : msg.from;
          const isMedia = msg.hasMedia || msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'document';
          const previewText = msg.body || (isMedia ? '[Mídia]' : '');

          // Atualizar preview do card no kanban
          setChatDetailsMap(prev => ({
            ...prev,
            [chatId]: {
              ...prev[chatId],
              lastMessage: previewText,
              lastMessageFromMe: msg.fromMe,
            }
          }));

          // Atualizar lista de chats
          setWaChats(prev => {
            const idx = prev.findIndex(c => (c.id._serialized || c.id) === chatId);
            if (idx >= 0) {
              const newChats = [...prev];
              newChats[idx] = {
                ...newChats[idx],
                unreadCount: msg.fromMe ? 0 : (newChats[idx].unreadCount + 1),
                timestamp: msg.timestamp
              };
              return newChats.sort((a, b) => b.timestamp - a.timestamp);
            }
            loadWaChats();
            return prev;
          });

          // Adicionar mensagem na conversa ativa
          const currentActiveChat = activeChatRef.current;
          if (currentActiveChat) {
            const currentChatId = currentActiveChat.id._serialized || currentActiveChat.id;
            if (chatId === currentChatId) {
              const formattedMsg = {
                id: { _serialized: msg.id, id: msg.id },
                from: msg.from,
                to: msg.to,
                body: msg.body,
                timestamp: msg.timestamp,
                hasMedia: msg.hasMedia,
                type: msg.type,
                fromMe: msg.fromMe,
              };

              setChatMessages(prev => {
                const already = prev.some(m => {
                  const mId = m.id?._serialized || m.id?.id || m.id;
                  return mId === msg.id;
                });
                if (already) return prev;
                return [...prev, formattedMsg];
              });
              setTimeout(scrollToBottom, 100);
            }
          }
        }
      } catch (e) {
        console.error('[SSE] Erro ao processar evento:', e);
      }
    };

    es.onerror = () => {
      console.warn('[SSE] Conexão perdida, tentando reconectar...');
    };

    return () => { es.close(); };
  }, []);

  const firstColId = kanbanState.columns[0]?.id;
  const mergedCards = waChats.map(chat => {
      const chatId = typeof chat.id === 'object' ? chat.id._serialized : chat.id;
      const existingCard = kanbanState.cards.find(c => c.id === chatId);
      const details = chatDetailsMap[chatId] || {};
      
      return {
          id: chatId || '',
          name: details.name || chat.name || (typeof chat.id === 'object' ? chat.id.user : chat.id?.split('@')[0]) || 'Desconhecido',
          unreadCount: chat.unreadCount,
          lastMessage: details.lastMessage !== undefined ? details.lastMessage : chat.lastMessage,
          lastMessageFromMe: details.lastMessageFromMe !== undefined ? details.lastMessageFromMe : chat.lastMessageFromMe,
          profilePicUrl: details.profilePicUrl !== undefined ? details.profilePicUrl : chat.profilePicUrl,
          timestamp: chat.timestamp,
          colId: existingCard ? existingCard.colId : (firstColId || ''),
          tagIds: existingCard ? existingCard.tagIds : []
      };
  }).filter(card => {
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      
      const safeName = card.name || '';
      const safeId = card.id || '';
      
      if (safeName.toLowerCase().includes(term)) return true;
      if (safeId.toLowerCase().includes(term)) return true;
      
      const hasMatchingTag = card.tagIds.some(tid => {
          const tag = kanbanState.tags.find(t => t.id === tid);
          return tag && (tag.name || '').toLowerCase().includes(term);
      });
      return hasMatchingTag;
  });

  useEffect(() => {
     const fetchMissingInfo = async () => {
         const missingIds = mergedCards
             .map(c => c.id)
             .filter(id => !chatDetailsMap[id] || chatDetailsMap[id].profilePicUrl === undefined);

         if (missingIds.length === 0) return;

         for (const id of missingIds) {
             setChatDetailsMap(prev => ({ ...prev, [id]: { ...(prev[id] || {}), profilePicUrl: null } }));
             try {
                 const info = await api.getWhatsAppChatInfo(id);
                 setChatDetailsMap(prev => ({
                     ...prev,
                     [id]: {
                         profilePicUrl: info.profilePicUrl,
                         lastMessage: info.lastMessage,
                         lastMessageFromMe: info.lastMessageFromMe,
                         name: info.pushname,
                         number: info.number
                     }
                 }));
             } catch(e) {}
         }
     };

     if (mergedCards.length > 0) {
         fetchMissingInfo();
     }
  }, [waChats, kanbanState.cards]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, colId: string) => {
    e.preventDefault();
    const chatId = e.dataTransfer.getData("chatId");
    if (!chatId) return;

    const newCards = [...kanbanState.cards];
    const cardIdx = newCards.findIndex(c => c.id === chatId);
    if (cardIdx >= 0) {
        newCards[cardIdx].colId = colId;
    } else {
        newCards.push({ id: chatId, colId, tagIds: [], name: '' });
    }
    
    await updateKanbanState({ ...kanbanState, cards: newCards });
  };

  const updateKanbanState = async (newState: WaKanbanState) => {
      const newSettings = { ...userSettings, waKanban: newState };
      try {
          await api.saveSettings(newSettings);
          onSaveSettings(newSettings);
      } catch (e) {}
  };

  const handleLoadContact = async () => {
      if (!contactNumber) return;
      try {
          setLoading(true);
          const contact = await api.getWhatsAppContact(contactNumber);
          if (contact) {
              const newCardId = contact.id;
              
              const existsInKanban = kanbanState.cards.find(c => c.id === newCardId);
              if (!existsInKanban) {
                  const newCard: WaKanbanCard = { 
                      id: newCardId, 
                      tagIds: [], 
                      colId: kanbanState.columns[0]?.id || '',
                      name: contact.name || newCardId.split('@')[0]
                  };
                  await updateKanbanState({ ...kanbanState, cards: [...kanbanState.cards, newCard] });
              }

              setWaChats(prev => {
                  if (prev.find(c => c.id._serialized === newCardId)) return prev;
                  return [{
                      id: { _serialized: newCardId, user: newCardId.split('@')[0] },
                      name: contact.name || newCardId.split('@')[0],
                      unreadCount: 0,
                      timestamp: Date.now() / 1000,
                      isGroup: contact.isGroup
                  }, ...prev];
              });
          }
      } catch (e) {
          alert('Erro ao carregar contato');
      } finally {
          setLoading(false);
          setContactNumber('');
      }
  };

  const [msgLimit, setMsgLimit] = useState(50);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
      messagesEndRef.current?.scrollIntoView();
  };

  // Função para carregar mensagens do banco
  const loadMessagesFromDb = async (chatId: string, before?: number): Promise<any[]> => {
    const token = localStorage.getItem('cm_auth_token');
    const url = before
      ? `/api/whatsapp/messages-db/${chatId}?limit=50&before=${before}`
      : `/api/whatsapp/messages-db/${chatId}?limit=50`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) throw new Error('Falha ao carregar mensagens do banco');
    return res.json();
  };

  const checkSyncStatus = async (chatId: string) => {
    const token = localStorage.getItem('cm_auth_token');
    const res = await fetch(`/api/whatsapp/sync-status/${chatId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const status = await res.json();
      setSyncStatus(prev => ({ ...prev, [chatId]: status }));
      return status;
    }
    return null;
  };

  // openChat corrigido - carrega do banco
  const openChat = async (cardItem: any) => {
    const chatId = cardItem.id;
    setActiveChat({ id: { _serialized: chatId }, name: cardItem.name });
    setChatLoading(true);
    setMsgLimit(50);

    try {
      const msgs = await loadMessagesFromDb(chatId);
      setChatMessages(msgs);
      setTimeout(scrollToBottom, 100);
      checkSyncStatus(chatId);
    } catch (e) {
      console.error('[openChat] Erro ao carregar do banco:', e);
      setChatMessages([]);
    } finally {
      setChatLoading(false);
    }
  };

  // loadMoreMessages corrigido - scroll infinito
  const loadMoreMessages = async () => {
    if (!activeChat || chatLoading) return;
    setChatLoading(true);

    try {
      const chatId = activeChat.id._serialized || activeChat.id;

      const oldestTimestamp = chatMessages.length > 0
        ? Math.min(...chatMessages.map(m => m.timestamp))
        : undefined;

      const olderMsgs = await loadMessagesFromDb(chatId, oldestTimestamp);

      if (olderMsgs.length > 0) {
        const container = document.querySelector('[data-chat-container]');
        const scrollHeightBefore = container?.scrollHeight || 0;

        setChatMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id?._serialized || m.id?.id));
          const newMsgs = olderMsgs.filter(m => {
            const id = m.id?._serialized || m.id?.id;
            return !existingIds.has(id);
          });
          return [...newMsgs, ...prev];
        });

        setTimeout(() => {
          if (container) {
            container.scrollTop = container.scrollHeight - scrollHeightBefore;
          }
        }, 50);
      } else {
        const newLimit = msgLimit + 50;
        setMsgLimit(newLimit);
        const msgs = await api.getWhatsAppMessages(chatId, newLimit);

        if (msgs.length > 0) {
          const token = localStorage.getItem('cm_auth_token');
          fetch(`/api/whatsapp/messages/${chatId}?limit=${newLimit}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
        }

        setChatMessages(msgs);
      }
    } catch (e) {
      console.error('[loadMoreMessages] Erro:', e);
    } finally {
      setChatLoading(false);
    }
  };

  // Carregar histórico de 45 dias
  const loadHistoryFrom45Days = async () => {
    if (!activeChat || isLoadingHistory) return;
    const chatId = activeChat.id._serialized || activeChat.id;

    setIsLoadingHistory(true);
    try {
      const token = localStorage.getItem('cm_auth_token');
      const res = await fetch(`/api/whatsapp/load-history/${chatId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const result = await res.json();

      if (result.already_synced) {
        alert(`Histórico já carregado anteriormente.\nÚltima sincronização: ${new Date(result.lastSync * 1000).toLocaleString('pt-BR')}`);
      } else if (result.success) {
        alert(`✅ ${result.count} mensagens carregadas com sucesso!`);
        const msgs = await loadMessagesFromDb(chatId);
        setChatMessages(msgs);
        setTimeout(scrollToBottom, 100);
        setHistoryLoaded(prev => ({ ...prev, [chatId]: true }));
        checkSyncStatus(chatId);
      } else {
        alert('Erro ao carregar histórico: ' + (result.error || 'Tente novamente'));
      }
    } catch (e: any) {
      alert('Erro de conexão: ' + e.message);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // handleSendMessage corrigido com optimistic update
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!newMessageText.trim() && !selectedMedia) || !activeChat || sendingMsg) return;

    const textToSend = newMessageText;
    const mediaToSend = selectedMedia;

    setSendingMsg(true);
    setNewMessageText('');
    setSelectedMedia(null);

    const optimisticMsg = {
      id: { _serialized: `optimistic_${Date.now()}`, id: `optimistic_${Date.now()}` },
      body: textToSend,
      timestamp: Math.floor(Date.now() / 1000),
      fromMe: true,
      type: mediaToSend ? (mediaToSend.type.startsWith('image') ? 'image' : 'document') : 'chat',
      hasMedia: !!mediaToSend,
      _optimistic: true
    };
    setChatMessages(prev => [...prev, optimisticMsg]);
    setTimeout(scrollToBottom, 50);

    try {
      await api.sendWhatsAppChat({
        chatId: activeChat.id._serialized,
        message: textToSend,
        media: mediaToSend || undefined
      });
    } catch (e) {
      setChatMessages(prev => prev.filter(m => !m._optimistic));
      setNewMessageText(textToSend);
      setSelectedMedia(mediaToSend);
      alert('Erro ao enviar mensagem. Tente novamente.');
    } finally {
      setSendingMsg(false);
    }
  };

  const handleTranscribe = async (msgId: string) => {
      setTranscribingMap(prev => ({...prev, [msgId]: true}));
      try {
          const res = await api.transcribeWhatsAppAudio(msgId);
          setChatMessages(prev => prev.map(m => {
              if (m.id.id === msgId || m.id._serialized === msgId) {
                  return { ...m, transcription: res.transcription };
              }
              return m;
          }));
      } catch (e) {
          alert('Erro ao transcrever');
      } finally {
          setTranscribingMap(prev => ({...prev, [msgId]: false}));
      }
  };

  const formatWaMarkdown = (text: string) => {
      if (!text) return "";
      let formatted = text.replace(/\*([^*_~]+)\*/g, '**$1**');
      formatted = formatted.replace(/_([^*_~]+)_/g, '*$1*');
      formatted = formatted.replace(/~([^*_~]+)~/g, '~~$1~~');
      return formatted;
  };

  if (loading && waChats.length === 0) {
      return <div className="flex justify-center p-10"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="h-full flex flex-col space-y-4">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-white p-4 rounded-lg shadow-sm border border-gray-100 gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <MessageCircle className="w-6 h-6 text-green-500" /> Kanban WhatsApp
          </h2>
          <p className="text-sm text-gray-500">Gerencie suas conversas eficientemente</p>
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
           <div className="flex bg-white border border-gray-200 rounded-lg overflow-hidden shrink-0 shadow-sm grow md:grow-0">
               <div className="pl-3 flex items-center justify-center text-gray-400">
                  <Search className="w-4 h-4" />
               </div>
               <input 
                  type="text"
                  placeholder="Pesquisar (Nome, n°, tag)..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="px-3 py-2 bg-transparent outline-none flex-1 text-sm min-w-[200px]"
               />
           </div>
           <div className="flex bg-gray-50 border border-gray-200 rounded-lg overflow-hidden shrink-0">
               <input 
                  type="text"
                  placeholder="Carregar Número (Ex: 55119999999)"
                  value={contactNumber}
                  onChange={e => setContactNumber(e.target.value)}
                  className="px-3 py-2 bg-transparent outline-none flex-1 text-sm min-w-[200px]"
               />
               <button onClick={handleLoadContact} className="px-3 text-gray-600 hover:bg-gray-200 transition-colors">
                   <Phone className="w-4 h-4" />
               </button>
           </div>
           <button 
             onClick={() => setIsConfigModalOpen(true)}
             className="p-2 border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
             title="Configurar Colunas e Tags"
           >
              <Settings className="w-5 h-5" />
           </button>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 overflow-x-auto flex gap-4 pb-4">
          {kanbanState.columns.map(col => {
              const colCards = mergedCards.filter(c => c.colId === col.id);
              
              return (
                  <div 
                      key={col.id} 
                      className="flex-shrink-0 w-80 bg-gray-100 rounded-xl p-3 flex flex-col h-full overflow-hidden"
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, col.id)}
                  >
                      <div className="mb-3 pb-2 border-b-2 flex items-center justify-between" style={{ borderColor: col.color }}>
                          <h3 className="font-bold text-gray-700 flex items-center gap-2">
                             {col.title}
                             <span className="bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full text-xs font-semibold">{colCards.length}</span>
                          </h3>
                      </div>
                      
                      <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                          {colCards.map(card => (
                              <div 
                                  key={card.id}
                                  draggable
                                  onDragStart={(e) => {
                                      e.dataTransfer.setData("chatId", card.id);
                                      e.dataTransfer.effectAllowed = "move";
                                  }}
                                  onClick={() => openChat(card)}
                                  className="bg-white p-3 rounded-xl shadow-sm border border-gray-100 cursor-pointer hover:shadow-lg hover:border-blue-300 transition-all active:cursor-grabbing border-l-4 group"
                                  style={{ borderLeftColor: col.color }}
                              >
                                  <div className="flex items-center gap-3 mb-2">
                                      <div className="w-10 h-10 rounded-full bg-gray-100 flex-shrink-0 overflow-hidden border border-gray-200">
                                          {card.profilePicUrl ? (
                                              <img src={card.profilePicUrl} alt={card.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                          ) : (
                                              <User className="w-full h-full p-2 text-gray-400" />
                                          )}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                          <div className="flex justify-between items-start">
                                              <h4 className="font-semibold text-gray-800 text-sm truncate">{card.name}</h4>
                                              {card.unreadCount > 0 && (
                                                  <span className="bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                                                      {card.unreadCount}
                                                  </span>
                                              )}
                                          </div>
                                      </div>
                                  </div>

                                  <div className="flex items-center gap-1 text-sm text-gray-500 mb-2 truncate">
                                      {card.lastMessageFromMe && <CheckCircle2 className="w-4 h-4 text-blue-500 flex-shrink-0" />}
                                      <p className="truncate">{card.lastMessage || 'Sem mensagem'}</p>
                                  </div>
                                  
                                  <div className="flex items-center justify-between mt-3">
                                      <div className="flex flex-wrap gap-1 items-center flex-1 min-w-0">
                                          {card.tagIds.map(tid => {
                                              const tag = kanbanState.tags.find(t => t.id === tid);
                                              if (!tag) return null;
                                              return (
                                                <span key={tag.id} className="text-xs px-2 py-0.5 border rounded-full flex items-center gap-1 font-medium bg-gray-50 max-w-full truncate" style={{borderColor: tag.color, color: tag.color}}>
                                                    <div className="w-1.5 h-1.5 rounded-full" style={{backgroundColor: tag.color}}></div>
                                                    <span className="truncate">{tag.name}</span>
                                                </span>
                                              );
                                          })}
                                      </div>

                                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                          <div className="relative">
                                              <button 
                                                  onClick={(e) => {
                                                      e.stopPropagation();
                                                      setTagMenuCardId(tagMenuCardId === card.id ? null : card.id);
                                                  }}
                                                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-colors"
                                                  title="Adicionar Tag"
                                              >
                                                  <Plus className="w-4 h-4" />
                                              </button>
                                              
                                              {tagMenuCardId === card.id && (
                                                  <div className="absolute right-0 bottom-full mb-2 bg-white border border-gray-100 shadow-xl rounded-lg p-2 w-48 z-50 animate-in fade-in zoom-in duration-150" onClick={e => e.stopPropagation()}>
                                                      <div className="text-xs font-semibold text-gray-500 mb-2 px-1">Tags</div>
                                                      <div className="max-h-40 overflow-y-auto space-y-1 scrollbar-thin">
                                                          {kanbanState.tags.map(t => {
                                                              const hasTag = card.tagIds.includes(t.id);
                                                              return (
                                                                  <label key={t.id} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer text-sm transition-colors">
                                                                      <input type="checkbox" checked={!!hasTag} onChange={(e) => {
                                                                          const newCards = [...kanbanState.cards];
                                                                          let cIdx = newCards.findIndex(c => c.id === card.id);
                                                                          if(cIdx < 0) {
                                                                              newCards.push({ id: card.id, colId: col.id, tagIds: [], name: card.name });
                                                                              cIdx = newCards.length - 1;
                                                                          }
                                                                          let tags = newCards[cIdx].tagIds;
                                                                          if(e.target.checked) tags.push(t.id);
                                                                          else tags = tags.filter(id => id !== t.id);
                                                                          newCards[cIdx].tagIds = tags;
                                                                          updateKanbanState({...kanbanState, cards: newCards});
                                                                      }} className="rounded text-blue-600 focus:ring-blue-500"/>
                                                                      <div className="w-2 h-2 rounded-full" style={{backgroundColor: t.color}}></div>
                                                                      <span className="font-medium text-gray-700 truncate">{t.name}</span>
                                                                  </label>
                                                              );
                                                          })}
                                                          {kanbanState.tags.length === 0 && (
                                                              <div className="text-xs text-gray-400 p-1">Nenhuma tag criada</div>
                                                          )}
                                                      </div>
                                                  </div>
                                              )}
                                          </div>
                                          <button 
                                              onClick={(e) => {
                                                  e.stopPropagation();
                                                  if (confirm('Remover esta conversa do Kanban?')) {
                                                      const newCards = kanbanState.cards.filter(c => c.id !== card.id);
                                                      updateKanbanState({...kanbanState, cards: newCards});
                                                  }
                                              }}
                                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors"
                                              title="Remover do Kanban"
                                          >
                                              <Trash2 className="w-4 h-4" />
                                          </button>
                                      </div>
                                  </div>
                              </div>
                          ))}
                      </div>
                  </div>
              );
          })}
          {kanbanState.columns.length === 0 && (
              <div className="flex items-center justify-center w-full h-40 text-gray-400">
                  <p>Nenhuma coluna configurada. Clique na engrenagem para adicionar.</p>
              </div>
          )}
      </div>

      {/* Kanban Config Modal */}
      {isConfigModalOpen && (
          <div className="fixed inset-0 z-50 bg-black/50 flex flex-col items-center justify-center p-4">
              <div className="bg-white rounded-xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh]">
                  <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                      <h3 className="font-bold text-gray-800 flex items-center gap-2"><Settings className="w-5 h-5"/> Configurar Kanban</h3>
                      <button onClick={() => setIsConfigModalOpen(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5"/></button>
                  </div>
                  <div className="p-6 overflow-y-auto space-y-8 flex-1">
                      {/* Columns Config */}
                      <div>
                          <h4 className="font-semibold text-gray-700 mb-3 border-b pb-2">Colunas</h4>
                          <div className="space-y-2">
                             {kanbanState.columns.map(col => (
                                 <div key={col.id} className="flex gap-2 items-center">
                                     <input type="color" value={col.color} onChange={e => {
                                         const newCols = kanbanState.columns.map(c => c.id === col.id ? {...c, color: e.target.value} : c);
                                         updateKanbanState({...kanbanState, columns: newCols});
                                     }} className="w-10 h-10 p-1 rounded cursor-pointer" />
                                     <input type="text" value={col.title} onChange={e => {
                                         const newCols = kanbanState.columns.map(c => c.id === col.id ? {...c, title: e.target.value} : c);
                                         updateKanbanState({...kanbanState, columns: newCols});
                                     }} className="flex-1 border rounded px-3 py-2 outline-none focus:border-blue-500" />
                                     <button onClick={() => {
                                         if(confirm('Excluir coluna?')) updateKanbanState({...kanbanState, columns: kanbanState.columns.filter(c => c.id !== col.id)});
                                     }} className="text-red-500 hover:bg-red-50 p-2 rounded">Excluir</button>
                                 </div>
                             ))}
                             <button onClick={() => {
                                 const newCols = [...kanbanState.columns, { id: 'col_'+Date.now(), title: 'Nova Coluna', color: '#cbd5e1' }];
                                 updateKanbanState({...kanbanState, columns: newCols});
                             }} className="text-sm font-medium text-blue-600 hover:bg-blue-50 px-3 py-2 rounded flex items-center gap-1">
                                 <Plus className="w-4 h-4"/> Adicionar Coluna
                             </button>
                          </div>
                      </div>

                      {/* Tags Config */}
                      <div>
                          <h4 className="font-semibold text-gray-700 mb-3 border-b pb-2">Tags</h4>
                          <div className="space-y-2">
                             {kanbanState.tags.map(tag => (
                                 <div key={tag.id} className="flex gap-2 items-center">
                                     <input type="color" value={tag.color} onChange={e => {
                                         const newTags = kanbanState.tags.map(t => t.id === tag.id ? {...t, color: e.target.value} : t);
                                         updateKanbanState({...kanbanState, tags: newTags});
                                     }} className="w-10 h-10 p-1 rounded cursor-pointer" />
                                     <input type="text" value={tag.name} onChange={e => {
                                         const newTags = kanbanState.tags.map(t => t.id === tag.id ? {...t, name: e.target.value} : t);
                                         updateKanbanState({...kanbanState, tags: newTags});
                                     }} className="flex-1 border rounded px-3 py-2 outline-none focus:border-blue-500" />
                                     <button onClick={() => {
                                         if(confirm('Excluir tag?')) updateKanbanState({...kanbanState, tags: kanbanState.tags.filter(t => t.id !== tag.id)});
                                     }} className="text-red-500 hover:bg-red-50 p-2 rounded">Excluir</button>
                                 </div>
                             ))}
                             <button onClick={() => {
                                 const newTags = [...kanbanState.tags, { id: 'tag_'+Date.now(), name: 'Nova Tag', color: '#94a3b8' }];
                                 updateKanbanState({...kanbanState, tags: newTags});
                             }} className="text-sm font-medium text-blue-600 hover:bg-blue-50 px-3 py-2 rounded flex items-center gap-1">
                                 <Plus className="w-4 h-4"/> Adicionar Tag
                             </button>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* Chat UI Modal */}
      {activeChat && (
          <div className="fixed inset-0 z-50 bg-black/50 flex flex-col md:flex-row justify-end">
              <div className="bg-white w-full md:w-[600px] h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
                  <div className="bg-slate-100 p-4 border-b flex items-center justify-between">
                      <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-green-600 overflow-hidden">
                              {chatDetailsMap[activeChat.id._serialized || activeChat.id]?.profilePicUrl ? (
                                  <img src={chatDetailsMap[activeChat.id._serialized || activeChat.id].profilePicUrl!} alt={activeChat.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              ) : (
                                  <User className="w-5 h-5" />
                              )}
                          </div>
                          <div>
                              <h3 className="font-bold text-gray-800">{chatDetailsMap[activeChat.id._serialized || activeChat.id]?.name || activeChat.name}</h3>
                              <p className="text-xs text-gray-500">{chatDetailsMap[activeChat.id._serialized || activeChat.id]?.number ? `+${chatDetailsMap[activeChat.id._serialized || activeChat.id].number}` : (activeChat.id._serialized || activeChat.id)}</p>
                          </div>
                      </div>
                      <div className="flex items-center gap-3">
                           <div className="relative group">
                               <button className="text-gray-500 hover:text-gray-700 bg-white p-1.5 rounded-md border text-xs flex items-center gap-1">
                                  Tags
                               </button>
                               <div className="absolute right-0 top-full mt-1 bg-white border shadow-lg rounded-lg p-2 w-48 hidden group-hover:block z-50">
                                  {kanbanState.tags.map(t => {
                                      const cardInfo = kanbanState.cards.find(c => c.id === activeChat.id._serialized);
                                      const hasTag = cardInfo?.tagIds.includes(t.id);
                                      return (
                                          <label key={t.id} className="flex items-center gap-2 p-1 hover:bg-gray-50 cursor-pointer text-sm">
                                              <input type="checkbox" checked={!!hasTag} onChange={(e) => {
                                                  const newCards = [...kanbanState.cards];
                                                  let cIdx = newCards.findIndex(c => c.id === activeChat.id._serialized);
                                                  if(cIdx < 0) {
                                                      newCards.push({ id: activeChat.id._serialized, colId: firstColId || '', tagIds: [], name: activeChat.name });
                                                      cIdx = newCards.length - 1;
                                                  }
                                                  let tags = newCards[cIdx].tagIds;
                                                  if(e.target.checked) tags.push(t.id);
                                                  else tags = tags.filter(id => id !== t.id);
                                                  newCards[cIdx].tagIds = tags;
                                                  updateKanbanState({...kanbanState, cards: newCards});
                                              }} />
                                              <span style={{color: t.color}} className="font-medium">{t.name}</span>
                                          </label>
                                      );
                                  })}
                               </div>
                           </div>
                           <button onClick={() => setActiveChat(null)} className="text-gray-400 hover:text-gray-600"><X className="w-6 h-6"/></button>
                      </div>
                  </div>

                  <div
                    className="flex-1 overflow-y-auto p-4 space-y-4"
                    data-chat-container
                    style={{backgroundColor: '#efeae2', backgroundImage: `url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")`, backgroundRepeat: 'repeat', backgroundSize: '400px'}}
                  >
                      {chatLoading && chatMessages.length === 0 ? (
                          <div className="flex justify-center p-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
                      ) : (
                          <>
                              {/* Botão "Carregar mais antigas" do banco (scroll infinito) */}
                              {chatMessages.length > 0 && (
                                  <div className="flex justify-center mb-2">
                                      <button
                                          onClick={loadMoreMessages}
                                          disabled={chatLoading}
                                          className="text-sm bg-white/90 border border-gray-200 text-gray-600 px-4 py-1.5 rounded-full shadow-sm hover:bg-white flex items-center gap-2 transition-all"
                                      >
                                          {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                          Carregar mais antigas
                                      </button>
                                  </div>
                              )}

                              {/* Botão principal "Carregar histórico (45 dias)" */}
                              {!historyLoaded[activeChat.id._serialized] && !syncStatus[activeChat.id._serialized]?.synced && (
                                  <div className="flex justify-center mb-3">
                                      <button
                                          onClick={loadHistoryFrom45Days}
                                          disabled={isLoadingHistory}
                                          className="text-sm bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-full shadow-md flex items-center gap-2 font-medium transition-all disabled:opacity-60"
                                      >
                                          {isLoadingHistory
                                              ? <><Loader2 className="w-4 h-4 animate-spin" /> Carregando histórico...</>
                                              : <><History className="w-4 h-4" /> Carregar histórico (45 dias)</>
                                          }
                                      </button>
                                  </div>
                              )}

                              {/* Mensagem de histórico já sincronizado */}
                              {(historyLoaded[activeChat.id._serialized] || syncStatus[activeChat.id._serialized]?.synced) && (
                                  <div className="flex justify-center mb-2">
                                      <span className="text-xs bg-white/70 text-gray-500 px-3 py-1 rounded-full">
                                          ✅ Histórico sincronizado •{' '}
                                          {syncStatus[activeChat.id._serialized]?.lastSync
                                              ? new Date(syncStatus[activeChat.id._serialized].lastSync! * 1000).toLocaleDateString('pt-BR')
                                              : 'recentemente'
                                          }
                                      </span>
                                  </div>
                              )}

                              {chatMessages.length === 0 && !chatLoading ? (
                                  <div className="flex flex-col items-center justify-center mt-10 gap-3">
                                      <div className="text-center text-gray-500 text-sm bg-white/90 py-3 px-5 rounded-xl shadow-sm inline-block">
                                          Nenhuma mensagem local encontrada.
                                      </div>
                                      {!historyLoaded[activeChat.id._serialized] && !syncStatus[activeChat.id._serialized]?.synced && (
                                          <button
                                              onClick={loadHistoryFrom45Days}
                                              disabled={isLoadingHistory}
                                              className="text-sm bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-full shadow-md flex items-center gap-2 font-medium"
                                          >
                                              {isLoadingHistory
                                                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</>
                                                  : <><History className="w-4 h-4" /> Carregar histórico (45 dias)</>
                                              }
                                          </button>
                                      )}
                                  </div>
                              ) : null}

                              {/* Mensagens */}
                              {chatMessages.map((msg, idx) => {
                                  const isMe = msg.fromMe;
                                  let msgTypeIcon = null;
                                  if(msg.type === 'image') msgTypeIcon = <ImageIcon className="w-4 h-4"/>;
                                  if(msg.type === 'document') msgTypeIcon = <FileText className="w-4 h-4"/>;
                                  if(msg.type === 'audio' || msg.type === 'ptt') msgTypeIcon = <Music className="w-4 h-4"/>;

                                  const msgIdStr = msg.id?.id || msg.id?._serialized;
                                  const isOptimistic = msg._optimistic;

                                  return (
                                      <div key={msgIdStr || idx} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                                          <div className={`max-w-[80%] rounded-xl p-3 shadow-sm ${isMe ? 'bg-green-100 rounded-tr-none' : 'bg-white rounded-tl-none border border-gray-100'} ${isOptimistic ? 'opacity-70' : ''}`}>
                                              {msgTypeIcon && (
                                                  <div className="flex flex-col gap-2 mb-1 border-b border-black/5 pb-1">
                                                      <div className="flex items-center gap-2 text-gray-500">
                                                          {msgTypeIcon}
                                                          <span className="text-xs font-semibold">{msg.type?.toUpperCase()}</span>
                                                          
                                                          {(msg.type === 'audio' || msg.type === 'ptt') && !msg.transcription && msgIdStr && !isOptimistic && (
                                                              <button 
                                                                onClick={() => handleTranscribe(msgIdStr)}
                                                                disabled={transcribingMap[msgIdStr]}
                                                                className="ml-2 text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-100 flex items-center min-w-[90px] justify-center"
                                                              >
                                                                  {transcribingMap[msgIdStr] ? <Loader2 className="w-3 h-3 animate-spin" /> : 'IA: Transcrever'}
                                                              </button>
                                                          )}
                                                      </div>
                                                      {(msg.type === 'audio' || msg.type === 'ptt') && msgIdStr && !isOptimistic && (
                                                          <audio 
                                                              controls 
                                                              className="mt-1 h-10 w-full max-w-[240px]" 
                                                              src={`/api/whatsapp/media/${msgIdStr}?token=${localStorage.getItem('cm_auth_token')}`}
                                                              preload="metadata"
                                                          />
                                                      )}
                                                      {(msg.type === 'image' || msg.type === 'video') && msgIdStr && !isOptimistic && (
                                                          <img 
                                                              src={`/api/whatsapp/media/${msgIdStr}?token=${localStorage.getItem('cm_auth_token')}`} 
                                                              alt="Media" 
                                                              className="mt-2 rounded-lg max-h-[200px] object-cover cursor-pointer hover:opacity-90 border border-gray-200" 
                                                              onClick={() => {
                                                                  setExpandedMediaUrl(`/api/whatsapp/media/${msgIdStr}?token=${localStorage.getItem('cm_auth_token')}`);
                                                                  setExpandedMediaType(msg.type as 'image' | 'video');
                                                              }}
                                                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                                              loading="lazy"
                                                          />
                                                      )}
                                                      {msg.type === 'document' && msgIdStr && !isOptimistic && (
                                                          <div className="flex gap-2 mt-2">
                                                              <button 
                                                                  onClick={() => {
                                                                      setExpandedMediaUrl(`/api/whatsapp/media/${msgIdStr}?token=${localStorage.getItem('cm_auth_token')}`);
                                                                      setExpandedMediaType('document');
                                                                  }}
                                                                  className="flex-1 flex items-center justify-center p-2 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 text-blue-700 text-sm font-medium transition-colors gap-1"
                                                              >
                                                                  <FileText className="w-4 h-4" /> Visualizar
                                                              </button>
                                                              <a
                                                                  href={`/api/whatsapp/media/${msgIdStr}?token=${localStorage.getItem('cm_auth_token')}`}
                                                                  download
                                                                  className="flex items-center justify-center p-2 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 text-gray-600 text-sm transition-colors"
                                                                  title="Baixar"
                                                              >
                                                                  <Download className="w-4 h-4" />
                                                              </a>
                                                          </div>
                                                      )}
                                                  </div>
                                              )}
                                              
                                              {msg.body && (
                                                  <div className="text-sm text-gray-800 break-words markdown-body whatsapp-md">
                                                      <ReactMarkdown>{formatWaMarkdown(msg.body)}</ReactMarkdown>
                                                  </div>
                                              )}

                                              {msg.transcription && (
                                                  <div className="mt-2 p-2 bg-blue-50 border-l-2 border-blue-500 text-sm text-gray-800 rounded">
                                                      <strong>Transcrição IA:</strong><br/>
                                                      <ReactMarkdown>{formatWaMarkdown(msg.transcription)}</ReactMarkdown>
                                                  </div>
                                              )}
                                              
                                              <div className={`text-[10px] text-right mt-1 ${isMe ? 'text-green-700/70' : 'text-gray-400'}`}>
                                                  {new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                                  {isOptimistic && ' ⏳'}
                                              </div>
                                          </div>
                                      </div>
                                  );
                              })}
                          </>
                      )}
                      
                      <div ref={messagesEndRef} />
                  </div>

                  <form onSubmit={handleSendMessage} className="p-3 bg-slate-100 border-t flex items-end gap-2">
                      <div className="flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm flex flex-col">
                          {selectedMedia && (
                              <div className="bg-gray-50 p-2 border-b text-xs flex justify-between items-center text-gray-600">
                                  <span className="truncate max-w-[200px]">{selectedMedia.name}</span>
                                  <button type="button" onClick={() => setSelectedMedia(null)} className="text-red-500 hover:bg-red-50 p-1 rounded"><X className="w-3 h-3"/></button>
                              </div>
                          )}
                          <div className="flex items-end">
                              <label className="p-3 text-gray-400 hover:text-gray-600 cursor-pointer">
                                  <input type="file" className="hidden" accept="image/*, application/pdf, audio/*" onChange={e => e.target.files && setSelectedMedia(e.target.files[0])} />
                                  <Paperclip className="w-5 h-5"/>
                              </label>
                              <textarea 
                                  value={newMessageText}
                                  onChange={e => setNewMessageText(e.target.value)}
                                  onKeyDown={e => {
                                      if(e.key === 'Enter' && !e.shiftKey) {
                                          e.preventDefault();
                                          handleSendMessage(e);
                                      }
                                  }}
                                  placeholder="Digite uma mensagem..."
                                  className="flex-1 max-h-32 min-h-[44px] py-3 outline-none resize-none bg-transparent"
                                  rows={1}
                              />
                          </div>
                      </div>
                      <button 
                          type="submit"
                          disabled={sendingMsg || (!newMessageText.trim() && !selectedMedia)}
                          className="w-11 h-11 bg-green-500 text-white rounded-full flex items-center justify-center hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shrink-0"
                      >
                          {sendingMsg ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5 ml-1"/>}
                      </button>
                  </form>
              </div>
          </div>
      )}

      {expandedMediaUrl && (
          <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center animate-in fade-in duration-200">
              <button 
                  className="absolute top-4 right-4 text-white bg-black/50 hover:bg-black/80 rounded-full p-2 "
                  onClick={() => {
                      setExpandedMediaUrl(null);
                      setExpandedMediaType(null);
                  }}
              >
                  <X className="w-8 h-8" />
              </button>
              
              <div className="max-w-[90vw] max-h-[90vh] overflow-auto flex items-center justify-center">
                  {(expandedMediaType === 'image' || expandedMediaType === 'video') && (
                      <img src={expandedMediaUrl} className="max-w-full max-h-[90vh] object-contain rounded-lg" alt="Expanded Media" />
                  )}
                  {expandedMediaType === 'document' && (
                      <iframe src={expandedMediaUrl} className="w-[80vw] h-[80vh] bg-white rounded-lg" title="Document Viewer" />
                  )}
              </div>
          </div>
      )}
    </div>
  );
};

export default Dashboard;
