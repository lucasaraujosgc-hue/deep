import React, { useState, useRef, useEffect } from 'react';
import { Bot, X, Send, Loader2, Move } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api } from '../services/api';

const AiFab: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<{role: 'user' | 'ai', text: string}[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  
  const handleSend = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || loading) return;

      const userMsg = input;
      setInput('');
      setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
      setLoading(true);

      try {
          const token = localStorage.getItem('cm_auth_token');
          const res = await fetch('/api/ai/chat', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ message: userMsg })
          });
          const data = await res.json();
          if(data.reply) {
              setMessages(prev => [...prev, { role: 'ai', text: data.reply }]);
          }
      } catch (e) {
          setMessages(prev => [...prev, { role: 'ai', text: 'Desculpe, ocorreu um erro ao comunicar com a IA.' }]);
      } finally {
          setLoading(false);
      }
  };

  return (
    <>
      <div className="fixed z-[100] right-6 bottom-6 flex flex-col items-center gap-2">
        {!isOpen && (
            <button 
                onClick={() => setIsOpen(true)}
                className="w-14 h-14 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full flex items-center justify-center text-white shadow-xl hover:scale-105 transition-transform"
            >
                <Bot className="w-7 h-7" />
            </button>
        )}
      </div>

      {isOpen && (
          <div className="fixed z-[101] bottom-6 right-6 bg-white rounded-2xl shadow-2xl flex flex-col w-[320px] md:w-[380px] h-[500px] max-h-[80vh] border border-blue-100 overflow-hidden">
              <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-3 flex justify-between items-center cursor-default">
                  <div className="flex items-center gap-2 text-white font-semibold">
                      <Bot className="w-5 h-5"/>
                      Assistente IA
                  </div>
                  <button onClick={() => setIsOpen(false)} className="text-white/80 hover:text-white p-1">
                      <X className="w-5 h-5"/>
                  </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
                  {messages.length === 0 && (
                      <div className="text-center text-sm text-gray-500 mt-10">
                          <Bot className="w-10 h-10 mx-auto text-blue-200 mb-2"/>
                          Olá! Como posso ajudar você hoje em relação à sua contabilidade?
                      </div>
                  )}
                  {messages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[85%] rounded-xl p-3 text-sm shadow-sm ${m.role === 'user' ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-white text-gray-800 border border-gray-100 rounded-tl-none'}`}>
                              <div className="markdown-body text-sm leading-relaxed prose prose-sm">
                                  <ReactMarkdown>{m.text}</ReactMarkdown>
                              </div>
                          </div>
                      </div>
                  ))}
                  {loading && (
                      <div className="flex justify-start">
                          <div className="bg-white border border-gray-100 rounded-xl rounded-tl-none p-3 shadow-sm">
                              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                          </div>
                      </div>
                  )}
              </div>

              <form onSubmit={handleSend} className="p-3 bg-white border-t flex items-end gap-2">
                  <textarea 
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      placeholder="Pergunte algo à IA..."
                      className="flex-1 max-h-32 min-h-[44px] p-3 text-sm bg-gray-50 rounded-xl outline-none border border-gray-200 focus:border-blue-400 focus:ring-1 focus:ring-blue-400 resize-none"
                      rows={1}
                      onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSend(e);
                          }
                      }}
                  />
                  <button 
                      type="submit" 
                      disabled={loading || !input.trim()}
                      className="w-11 h-11 bg-blue-600 rounded-full flex items-center justify-center text-white shrink-0 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                      <Send className="w-4 h-4 ml-0.5" />
                  </button>
              </form>
          </div>
      )}
    </>
  );
};

export default AiFab;
