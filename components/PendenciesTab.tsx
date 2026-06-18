import React, { useState, useEffect } from 'react';
import { Upload, FileText, Download, UserPlus, Info, CheckCircle2, AlertTriangle, CloudRain, Briefcase } from 'lucide-react';
import { api } from '../services/api';

// This would ideally be in a shared type file, but keep it here for isolation
interface Pendency {
  type: string;
  period: string;
  value: string;
}

interface CompanyPendency {
  id: number | string;
  name: string;
  docNumber: string;
  hasPendencies: boolean;
  pendencies: Pendency[];
  lastUpdated: string;
  unmapped?: boolean;
}

const PendenciesTab: React.FC = () => {
    const [companies, setCompanies] = useState<CompanyPendency[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [selectedCompany, setSelectedCompany] = useState<CompanyPendency | null>(null);
    const [showModal, setShowModal] = useState(false);

    const fetchPendencies = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('cm_auth_token') || '';
            const res = await fetch('/api/pendencies/list', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (data.success) {
                setCompanies(data.list);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPendencies();
    }, []);

    const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>, companyId?: number | string) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        setUploading(true);
        const formData = new FormData();
        Array.from(files).forEach(file => {
            formData.append('files', file);
        });
        
        if (companyId && typeof companyId === 'number') {
            formData.append('companyId', companyId.toString());
        }

        try {
            const token = localStorage.getItem('cm_auth_token') || '';
            const res = await fetch('/api/pendencies/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            const data = await res.json();
            if (data.success) {
                fetchPendencies();
            } else {
                alert("Erro ao processar arquivo(s): " + (data.error || 'Desconhecido'));
            }
        } catch (e) {
            console.error(e);
            alert("Erro de conexão ao enviar arquivos.");
        } finally {
            setUploading(false);
        }
    };

    const handleViewPendencies = (company: CompanyPendency) => {
        setSelectedCompany(company);
        setShowModal(true);
    };

    return (
        <div className="flex flex-col h-full bg-slate-50">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-slate-800">Situação Fiscal</h1>
                    <p className="text-sm text-slate-500">Mapeie os relatórios da Receita Federal usando IA para extrair pendências.</p>
                </div>
                <div>
                     <label className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium shadow-sm transition-colors cursor-pointer flex items-center space-x-2">
                        {uploading ? (
                            <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                        ) : (
                            <Upload className="w-5 h-5" />
                        )}
                        <span>{uploading ? 'Analisando PDF...' : 'Upload em Lote'}</span>
                        <input 
                            type="file" 
                            multiple 
                            accept="application/pdf" 
                            className="hidden" 
                            onChange={(e) => handleUpload(e)}
                            disabled={uploading}
                        />
                    </label>
                </div>
            </div>

            <div className="bg-white border rounded-xl overflow-hidden shadow-sm flex-1 flex flex-col">
                <div className="overflow-x-auto flex-1">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="bg-slate-50 border-b text-slate-600 font-medium sticky top-0 z-10">
                            <tr>
                                <th className="px-6 py-4">Empresa</th>
                                <th className="px-6 py-4 text-center">Status</th>
                                <th className="px-6 py-4 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {loading ? (
                                <tr>
                                    <td colSpan={3} className="px-6 py-12 text-center text-slate-500">
                                        <div className="flex flex-col items-center justify-center space-y-3">
                                            <div className="w-8 h-8 border-4 border-blue-100 border-t-blue-500 rounded-full animate-spin"></div>
                                            <p>Carregando lista...</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : companies.length === 0 ? (
                                <tr>
                                    <td colSpan={3} className="px-6 py-12 text-center text-slate-500">
                                        Nenhuma empresa cadastrada ou pendência mapeada.
                                    </td>
                                </tr>
                            ) : (
                                companies.map(company => (
                                    <tr key={company.id} className="hover:bg-slate-50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-slate-800 flex items-center gap-2">
                                                {company.unmapped && <AlertTriangle className="w-4 h-4 text-orange-500" />}
                                                {company.name}
                                            </div>
                                            <div className="text-xs text-slate-500">{company.docNumber || 'Sem CNPJ'}</div>
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            {!company.hasPendencies ? (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-600">
                                                    Sem análise
                                                </span>
                                            ) : company.pendencies.length === 0 ? (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                                                    <CheckCircle2 className="w-3.5 h-3.5" /> Regular
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
                                                    <AlertTriangle className="w-3.5 h-3.5" /> Pendente
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex items-center justify-end gap-3 text-sm">
                                                <button 
                                                    onClick={() => handleViewPendencies(company)}
                                                    disabled={!company.hasPendencies}
                                                    className="font-medium text-slate-600 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    Ver Detalhes
                                                </button>
                                                {!company.unmapped && (
                                                    <label className="font-medium text-blue-600 hover:text-blue-700 cursor-pointer transition-colors relative">
                                                        Upload
                                                        <input 
                                                            type="file" 
                                                            accept="application/pdf" 
                                                            className="hidden" 
                                                            onChange={(e) => handleUpload(e, company.id)}
                                                            disabled={uploading}
                                                        />
                                                    </label>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Modal de Detalhes */}
            {showModal && selectedCompany && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        <div className="px-6 py-5 border-b flex justify-between items-center bg-slate-50/50">
                            <div>
                                <h3 className="font-semibold text-lg text-slate-800">Detalhes da Saúde Fiscal</h3>
                                <p className="text-xs text-slate-500 mt-0.5">{selectedCompany.name}</p>
                            </div>
                            <button 
                                onClick={() => setShowModal(false)}
                                className="text-slate-400 hover:text-slate-600 p-1"
                            >
                               ✕
                            </button>
                        </div>
                        <div className="p-6">
                            {selectedCompany.pendencies.length === 0 ? (
                                <div className="text-center py-8">
                                    <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3">
                                        <CheckCircle2 className="w-6 h-6" />
                                    </div>
                                    <h4 className="font-medium text-slate-800 mb-1">Situação Regular</h4>
                                    <p className="text-sm text-slate-500">Nenhuma irregularidade fiscal ou débito foi encontrada no último relatório mapeado pela IA.</p>
                                </div>
                            ) : (
                                <ul className="space-y-4">
                                    {selectedCompany.pendencies.map((pend, idx) => (
                                        <li key={idx} className="flex gap-4 p-4 rounded-xl border border-rose-100 bg-rose-50/30">
                                            <div className="mt-0.5">
                                                <AlertTriangle className="w-5 h-5 text-rose-500" />
                                            </div>
                                            <div className="flex-1">
                                                <h4 className="font-medium text-slate-800 text-sm">{pend.type || 'Débito não especificado'}</h4>
                                                <div className="flex items-center gap-3 mt-1.5">
                                                    {pend.period && (
                                                        <span className="text-xs font-medium text-rose-700 bg-rose-100 px-2 py-0.5 rounded-md">
                                                            {pend.period}
                                                        </span>
                                                    )}
                                                    {pend.value && (
                                                        <span className="text-xs text-slate-600 font-medium font-mono">
                                                            R$ {pend.value}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            
                            <div className="mt-6 text-xs text-slate-400 flex items-center gap-1.5">
                                <Info className="w-3.5 h-3.5" />
                                Última atualização: {selectedCompany.lastUpdated ? new Date(selectedCompany.lastUpdated).toLocaleString() : 'N/A'}
                            </div>
                        </div>
                        <div className="px-6 py-4 bg-slate-50 border-t flex justify-end">
                            <button 
                                onClick={() => setShowModal(false)}
                                className="px-4 py-2 font-medium bg-white border shadow-sm rounded-lg hover:bg-slate-50 transition-colors text-slate-700"
                            >
                                Fechar
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PendenciesTab;
