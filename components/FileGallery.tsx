import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { 
  FolderOpen, 
  Download, 
  Trash2, 
  FileText, 
  Image as ImageIcon, 
  Music, 
  Video, 
  File, 
  RefreshCw,
  MessageCircle,
  Mail
} from 'lucide-react';

const FileGallery: React.FC = () => {
  const [files, setFiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadFiles = async () => {
    try {
      setLoading(true);
      const data = await api.getFileGallery();
      setFiles(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
  }, []);

  const formatSize = (bytes: number) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleDelete = async (id: number) => {
      if (!confirm('Deseja deletar este arquivo?')) return;
      try {
          await api.deleteFileGallery(id);
          setFiles(files.filter(f => f.id !== id));
      } catch (e) {
          alert('Erro ao excluir');
      }
  };

  const getIcon = (mimeType: string) => {
      if (!mimeType) return <File className="w-8 h-8 text-gray-400" />;
      if (mimeType.includes('image')) return <ImageIcon className="w-8 h-8 text-blue-500" />;
      if (mimeType.includes('audio')) return <Music className="w-8 h-8 text-yellow-500" />;
      if (mimeType.includes('video')) return <Video className="w-8 h-8 text-red-500" />;
      if (mimeType.includes('pdf')) return <FileText className="w-8 h-8 text-red-400" />;
      return <File className="w-8 h-8 text-gray-400" />;
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FolderOpen className="w-6 h-6 text-blue-500" />
            Galeria de Arquivos
          </h2>
          <p className="text-sm text-gray-500">Mídias e documentos enviados e recebidos</p>
        </div>
        <div className="flex items-center gap-2">
            <button 
                onClick={async () => {
                    if (confirm('Tem certeza que deseja apagar todos os arquivos? Esta ação não pode ser desfeita.')) {
                        try {
                            const ids = files.map(f => f.id);
                            for (const id of ids) {
                                await api.deleteFileGallery(id);
                            }
                            loadFiles();
                        } catch (e) { alert('Erro ao limpar galeria'); }
                    }
                }}
                disabled={files.length === 0}
                className="flex items-center gap-2 px-3 py-2 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors disabled:opacity-50"
            >
                <Trash2 className="w-4 h-4" /> Apagar Todos
            </button>
            <button 
                onClick={loadFiles}
                className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
            >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {files.map(file => (
              <div key={file.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-shadow">
                  <div className="flex gap-3 items-start">
                      <div className="bg-slate-50 p-3 rounded-lg">
                          {getIcon(file.mimeType)}
                      </div>
                      <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-gray-800 truncate" title={file.originalName}>{file.originalName}</h3>
                          <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                              <span className="font-medium bg-gray-100 px-2 py-0.5 rounded">{formatSize(file.size)}</span>
                              <span>•</span>
                              <span>{new Date(file.timestamp).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                          </div>
                      </div>
                  </div>

                  <div className="bg-gray-50 p-3 rounded-lg text-sm flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                          <span className="text-gray-500">Contato:</span>
                          <span className="font-medium text-gray-700 truncate max-w-[150px]" title={file.contact}>{file.contact || 'Desconhecido'}</span>
                      </div>
                      <div className="flex items-center justify-between">
                          <span className="text-gray-500">Canal:</span>
                          <span className="font-medium text-gray-700 flex items-center gap-1">
                              {file.channel?.toLowerCase().includes('whatsapp') && <MessageCircle className="w-3 h-3 text-green-500" />}
                              {file.channel?.toLowerCase().includes('email') && <Mail className="w-3 h-3 text-blue-500" />}
                              {file.channel}
                          </span>
                      </div>
                      <div className="flex items-center justify-between">
                          <span className="text-gray-500">Direção:</span>
                          <span className={`font-medium px-2 py-0.5 rounded text-[10px] uppercase ${file.direction === 'sent' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                              {file.direction === 'sent' ? 'Enviado' : 'Recebido'}
                          </span>
                      </div>
                  </div>

                  <div className="flex gap-2 mt-auto">
                      <button 
                          onClick={() => window.open(`/api/file-gallery/download/${file.id}?token=${localStorage.getItem('cm_auth_token')}`, '_blank')}
                          className="flex-1 flex justify-center items-center gap-2 bg-blue-50 text-blue-600 hover:bg-blue-100 py-2 rounded-lg text-sm font-medium transition-colors"
                      >
                          <Download className="w-4 h-4" /> Baixar
                      </button>
                      <button 
                          onClick={() => handleDelete(file.id)}
                          className="flex justify-center items-center px-3 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition-colors"
                          title="Excluir"
                      >
                          <Trash2 className="w-4 h-4" />
                      </button>
                  </div>
              </div>
          ))}
          {files.length === 0 && !loading && (
              <div className="col-span-full py-10 text-center text-gray-400">
                  <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>Nenhum arquivo na galeria.</p>
              </div>
          )}
      </div>
    </div>
  );
};

export default FileGallery;
