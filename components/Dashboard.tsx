
import React, { useState, useEffect, useRef } from 'react';
import { 
  Building2, CheckCircle2, Clock, AlertCircle, Loader2, Bot, Power, User,
  Plus, MoreHorizontal, MessageCircle, Settings, X, Search, Phone, Send, Mic, Paperclip, Music, FileText, Image as ImageIcon
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
  const [waChats, setWaChats] = useState<any[]>([]); // All WA chats
  const [contactNumber, setContactNumber] = useState('');
  
  // Modals
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [activeChat, setActiveChat] = useState<any | null>(null); // To open chat UI
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [newMessageText, setNewMessageText] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<File | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [transcribingMap, setTranscribingMap] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');

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

  useEffect(() => {
    loadWaChats();
    // Start SSE stream
    const token = localStorage.getItem('cm_auth_token');
    const es = new EventSource(`/api/whatsapp/events?token=${token}`);
    
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'whatsapp_message') {
           // Reload chats to update last message
           loadWaChats();
           if (activeChat && data.message && (data.message.from === activeChat.id._serialized || data.message.to === activeChat.id._serialized)) {
             setChatMessages(prev => [...prev, data.message]);
           }
        }
      } catch (e) {}
    };

    return () => { es.close(); };
  }, [activeChat]);

  // Combine Kanban Cards with Real Chats
  // Provide defaults for chats that aren't manually assigned yet
  const firstColId = kanbanState.columns[0]?.id;
  const mergedCards = waChats.map(chat => {
      const existingCard = kanbanState.cards.find(c => c.id === chat.id._serialized);
      return {
          id: chat.id._serialized || '',
          name: chat.name || (chat.id && chat.id.user) || 'Desconhecido',
          unreadCount: chat.unreadCount,
          lastMessage: chat.lastMessage?.body,
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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, colId: string) => {
    e.preventDefault();
    const chatId = e.dataTransfer.getData("chatId");
    if (!chatId) return;

    // Move Card logic
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
              await loadWaChats();
          }
      } catch (e) {
          alert('Erro ao carregar contato');
      } finally {
          setLoading(false);
          setContactNumber('');
      }
  };

  const openChat = async (cardItem: any) => {
      setActiveChat({ id: { _serialized: cardItem.id }, name: cardItem.name });
      setChatLoading(true);
      try {
          const msgs = await api.getWhatsAppMessages(cardItem.id);
          setChatMessages(msgs.reverse());
      } catch (e) {
          console.error(e);
      } finally {
          setChatLoading(false);
      }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
      e.preventDefault();
      if ((!newMessageText.trim() && !selectedMedia) || !activeChat || sendingMsg) return;

      setSendingMsg(true);
      try {
          await api.sendWhatsAppChat({
              chatId: activeChat.id._serialized,
              message: newMessageText,
              media: selectedMedia || undefined
          });
          setNewMessageText('');
          setSelectedMedia(null);
          // O message_create recebido pelo SSE deve atualizar a tela
      } catch (e) {
          alert('Erro ao enviar mensagem');
      } finally {
          setSendingMsg(false);
      }
  };

  const handleTranscribe = async (msgId: string) => {
      setTranscribingMap(prev => ({...prev, [msgId]: true}));
      try {
          const res = await api.transcribeWhatsAppAudio(msgId);
          // Update the localized chat messages state to embed the transcription text
          setChatMessages(prev => prev.map(m => {
              if (m.id.id === msgId || m.id._serialized === msgId) {
                  return { ...m, transcription: res.text };
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
      // Basic translation from WhatsApp MD (*bold*, _italic_, ~strike~) to standard MD (**bold**, *italic*, ~~strike~~)
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
                                  className="bg-white p-3 rounded-lg shadow border border-gray-100 cursor-pointer hover:shadow-md hover:border-blue-300 transition-all active:cursor-grabbing border-l-4"
                                  style={{ borderLeftColor: col.color }}
                              >
                                  <div className="flex justify-between items-start mb-1">
                                      <h4 className="font-bold text-gray-800 text-sm truncate max-w-[180px]">{card.name}</h4>
                                      {card.unreadCount > 0 && (
                                          <span className="bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                                              {card.unreadCount}
                                          </span>
                                      )}
                                  </div>
                                  <p className="text-xs text-gray-500 line-clamp-2 min-h-[32px]">{card.lastMessage || 'Sem mensagem'}</p>
                                  
                                  {card.tagIds.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-2">
                                          {card.tagIds.map(tid => {
                                              const tag = kanbanState.tags.find(t => t.id === tid);
                                              if (!tag) return null;
                                              return (
                                                <span key={tag.id} className="text-[9px] px-1.5 py-0.5 rounded-full text-white" style={{backgroundColor: tag.color}}>
                                                    {tag.name}
                                                </span>
                                              );
                                          })}
                                      </div>
                                  )}
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
                          <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-green-600">
                              <User className="w-5 h-5" />
                          </div>
                          <div>
                              <h3 className="font-bold text-gray-800">{activeChat.name}</h3>
                              <p className="text-xs text-gray-500">{activeChat.id._serialized}</p>
                          </div>
                      </div>
                      <div className="flex items-center gap-3">
                           {/* Tag selector dropdown placeholder */}
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

                  <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50" style={{backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)', backgroundSize: '16px 16px'}}>
                      {chatLoading ? (
                          <div className="flex justify-center p-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
                      ) : (
                          chatMessages.map((msg, idx) => {
                              const isMe = msg.fromMe;
                              let msgTypeIcon = null;
                              if(msg.type === 'image') msgTypeIcon = <ImageIcon className="w-4 h-4"/>;
                              if(msg.type === 'document') msgTypeIcon = <FileText className="w-4 h-4"/>;
                              if(msg.type === 'audio' || msg.type === 'ptt') msgTypeIcon = <Music className="w-4 h-4"/>;

                              const msgIdStr = msg.id?.id || msg.id?._serialized;

                              return (
                                  <div key={idx} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                                      <div className={`max-w-[80%] rounded-xl p-3 shadow-sm ${isMe ? 'bg-green-100 rounded-tr-none' : 'bg-white rounded-tl-none border border-gray-100'}`}>
                                          {msgTypeIcon && (
                                              <div className="flex items-center gap-2 text-gray-500 mb-1 border-b pb-1">
                                                  {msgTypeIcon}
                                                  <span className="text-xs font-semibold">{msg.type.toUpperCase()}</span>
                                                  
                                                  {(msg.type === 'audio' || msg.type === 'ptt') && !msg.transcription && msgIdStr && (
                                                      <button 
                                                        onClick={() => handleTranscribe(msgIdStr)}
                                                        disabled={transcribingMap[msgIdStr]}
                                                        className="ml-2 text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-100 flex items-center min-w-[90px] justify-center"
                                                      >
                                                          {transcribingMap[msgIdStr] ? <Loader2 className="w-3 h-3 animate-spin" /> : 'IA: Transcrever'}
                                                      </button>
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
                                          </div>
                                      </div>
                                  </div>
                              );
                          })
                      )}
                      
                      {chatMessages.length === 0 && !chatLoading && (
                          <div className="text-center text-gray-400 text-sm mt-10">Nenhuma mensagem encontrada.</div>
                      )}
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
    </div>
  );
};

export default Dashboard;
