import React, { useState, useEffect, useMemo } from 'react';
import { Upload, FileText, Download, UserPlus, Info, CheckCircle2, AlertTriangle, CloudRain, Briefcase, Search, ArrowUpDown } from 'lucide-react';
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

const parseValue = (val: string) => {
    if (!val) return 0;
    const clean = val.replace(/\./g, '').replace(',', '.');
    return parseFloat(clean) || 0;
};

const formatValue = (val: number) => {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);
};

const PendenciesTab: React.FC = () => {
    const [companies, setCompanies] = useState<CompanyPendency[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [selectedCompany, setSelectedCompany] = useState<CompanyPendency | null>(null);
    const [showModal, setShowModal] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [sortOrder, setSortOrder] = useState<'status_desc' | 'status_asc' | 'name_asc'>('name_asc');

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

    const filteredAndSortedCompanies = useMemo(() => {
        let result = companies;
        
        // Filter
        if (searchTerm) {
            const lowerTerm = searchTerm.toLowerCase();
            result = result.filter(c => 
                c.name.toLowerCase().includes(lowerTerm) || 
                (c.docNumber && c.docNumber.includes(lowerTerm))
            );
        }

        // Sort
        result = [...result].sort((a, b) => {
            if (sortOrder === 'name_asc') {
                return a.name.localeCompare(b.name);
            } else {
                const getStatusWeight = (c: CompanyPendency) => {
                    if (c.unmapped) return 3;
                    if (c.hasPendencies && c.pendencies.length > 0) return 2;
                    if (c.hasPendencies && c.pendencies.length === 0) return 1;
                    return 0; // sem analise
                };
                
                const weightA = getStatusWeight(a);
                const weightB = getStatusWeight(b);
                
                if (sortOrder === 'status_desc') {
                    if (weightA !== weightB) return weightB - weightA;
                    return a.name.localeCompare(b.name);
                } else {
                    if (weightA !== weightB) return weightA - weightB;
                    return a.name.localeCompare(b.name);
                }
            }
        });

        return result;
    }, [companies, searchTerm, sortOrder]);

    const groupedPendencies = useMemo(() => {
        if (!selectedCompany || !selectedCompany.pendencies) return {};
        return selectedCompany.pendencies.reduce((acc, curr) => {
            const type = curr.type || 'Outros Débitos';
            if (!acc[type]) acc[type] = { items: [], total: 0 };
            acc[type].items.push(curr);
            acc[type].total += parseValue(curr.value);
            return acc;
        }, {} as Record<string, { items: Pendency[], total: number }>);
    }, [selectedCompany]);

    const toggleStatusSort = () => {
        if (sortOrder === 'status_desc') {
            setSortOrder('status_asc');
        } else if (sortOrder === 'status_asc') {
            setSortOrder('name_asc');
        } else {
            setSortOrder('status_desc');
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-50">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-slate-800">Situação Fiscal</h1>
                    <p className="text-sm text-slate-500">Mapeie os relatórios da Receita Federal usando IA para extrair pendências.</p>
                </div>
                <div className="flex items-center space-x-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                        <Search className="absolute text-slate-400 w-4 h-4 left-3 top-2.5" />
                        <input
                            type="text"
                            placeholder="Buscar empresa..."
                            className="bg-white border text-sm rounded-lg w-full pl-9 pr-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                    </div>
                    <label className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-sm transition-colors cursor-pointer flex items-center space-x-2 whitespace-nowrap">
                        {uploading ? (
                            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                        ) : (
                            <Upload className="w-4 h-4" />
                        )}
                        <span>{uploading ? 'Analisando...' : 'Upload Lote'}</span>
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

            <div className="bg-white border rounded-xl shadow-sm flex-1 flex flex-col min-h-0">
                <div className="overflow-auto flex-1 relative">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="bg-slate-50 border-b text-slate-600 font-medium sticky top-0 z-10 shadow-sm">
                            <tr>
                                <th className="px-6 py-4">Empresa</th>
                                <th className="px-6 py-4 text-center cursor-pointer hover:bg-slate-100 transition-colors" onClick={toggleStatusSort}>
                                    <div className="flex items-center justify-center gap-1.5">
                                        Status
                                        <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                                    </div>
                                </th>
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
                            ) : filteredAndSortedCompanies.length === 0 ? (
                                <tr>
                                    <td colSpan={3} className="px-6 py-12 text-center text-slate-500">
                                        Nenhuma empresa encontrada com os filtros atuais.
                                    </td>
                                </tr>
                            ) : (
                                filteredAndSortedCompanies.map(company => (
                                    <tr key={company.id} className="hover:bg-slate-50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-slate-800 flex items-center gap-2">
                                                {company.unmapped && <AlertTriangle className="w-4 h-4 text-orange-500" title="Empresa não localizada no banco, precisa associar."/>}
                                                {company.name}
                                            </div>
                                            <div className="text-xs text-slate-500">{company.docNumber || 'Sem CNPJ'}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col items-center gap-1.5">
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
                                                {company.hasPendencies && company.lastUpdated && (
                                                    <span className="text-[10px] text-slate-400">
                                                        {new Date(company.lastUpdated).toLocaleDateString()}
                                                    </span>
                                                )}
                                            </div>
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

            {/* Modal de Detalhes - Otimizado para rolagem vertical com dados horizontais */}
            {showModal && selectedCompany && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6 bg-slate-900/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
                        {/* Header Modal */}
                        <div className="px-6 py-4 border-b flex justify-between items-center bg-slate-50/50 shrink-0 rounded-t-2xl">
                            <div>
                                <h3 className="font-semibold text-lg text-slate-800">Saúde Fiscal Detalhada</h3>
                                <p className="text-xs text-slate-500 mt-0.5">{selectedCompany.name} ({selectedCompany.docNumber})</p>
                            </div>
                            <button 
                                onClick={() => setShowModal(false)}
                                className="text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full p-1.5 transition-colors"
                            >
                               ✕
                            </button>
                        </div>
                        
                        {/* Corpo Modal com scroll */}
                        <div className="p-6 overflow-y-auto flex-1">
                            {selectedCompany.pendencies.length === 0 ? (
                                <div className="text-center py-12">
                                    <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <CheckCircle2 className="w-7 h-7" />
                                    </div>
                                    <h4 className="font-medium text-slate-800 text-lg mb-1">Situação Regular</h4>
                                    <p className="text-sm text-slate-500">Nenhuma irregularidade fiscal ou débito foi encontrada no último relatório mapeado pela IA.</p>
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    {Object.entries(groupedPendencies).map(([type, group], idx) => (
                                        <div key={idx} className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                            {/* Cabeçalho do Grupo de Pendência */}
                                            <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 flex justify-between items-center">
                                                <div className="flex items-center gap-2">
                                                    <AlertTriangle className="w-4 h-4 text-rose-500" />
                                                    <h4 className="font-semibold text-slate-800 text-sm">{type}</h4>
                                                    <span className="bg-slate-200 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-full ml-1">
                                                        {group.items.length} itens
                                                    </span>
                                                </div>
                                                <div className="text-sm font-bold text-slate-700">
                                                    Total: <span className="text-rose-600 font-mono ml-1">{formatValue(group.total)}</span>
                                                </div>
                                            </div>
                                            
                                            {/* Itens do grupo na horizontal com quebra (wrap) */}
                                            <div className="p-4 bg-white flex flex-wrap gap-3">
                                                {group.items.map((pend, i) => (
                                                    <div key={i} className="flex flex-col bg-slate-50 border border-slate-100 rounded-lg p-2.5 min-w-[140px] flex-grow shadow-sm">
                                                        <span className="text-xs font-semibold text-slate-600 mb-1">
                                                            {pend.period || 'Sem período'}
                                                        </span>
                                                        <span className="text-sm font-mono text-slate-800">
                                                            {pend.value ? formatValue(parseValue(pend.value)) : '-'}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            
                            <div className="mt-8 text-xs text-slate-400 flex justify-end items-center gap-1.5">
                                <Info className="w-3.5 h-3.5" />
                                Atualizado pelo último PDF inserido em: {selectedCompany.lastUpdated ? new Date(selectedCompany.lastUpdated).toLocaleString() : 'N/A'}
                            </div>
                        </div>
                        
                        {/* Footer Modal */}
                        <div className="px-6 py-4 bg-slate-50 border-t flex justify-end shrink-0 rounded-b-2xl">
                            <button 
                                onClick={() => setShowModal(false)}
                                className="px-5 py-2 font-medium bg-white border border-slate-300 shadow-sm rounded-lg hover:bg-slate-100 transition-colors text-slate-700"
                            >
                                Fechar Detalhes
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PendenciesTab;

