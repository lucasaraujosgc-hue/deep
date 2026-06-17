import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Company } from '../types';
import { FileText, Loader2, Upload as UploadIcon, Info, X } from 'lucide-react';
import { extractTextFromPDF, identifyCompany } from '../utils/documentProcessor';

export default function Pendencies() {
    const [companies, setCompanies] = useState<Company[]>([]);
    const [pendenciesData, setPendenciesData] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isUploading, setIsUploading] = useState(false);
    const [selectedPendencies, setSelectedPendencies] = useState<{name: string, list: string[]}|null>(null);

    const loadData = async () => {
        setIsLoading(true);
        try {
            const comps = await api.getCompanies();
            setCompanies(comps);
            const pends = await api.getPendencies();
            setPendenciesData(pends);
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    const processFiles = async (fileList: File[], targetCompanyId?: number) => {
        setIsUploading(true);
        try {
            for (const file of fileList) {
                if (file.type !== 'application/pdf') continue;
                
                const text = await extractTextFromPDF(file);
                let compId = targetCompanyId;
                
                // If batch upload, find company using map
                if (!compId) {
                    const match = identifyCompany(text, companies);
                    if (match) compId = match.id;
                }
                
                if (compId) {
                    await api.extractPendencies(compId, text);
                } else {
                    console.warn("Nenhuma empresa identificada para o arquivo", file.name);
                }
            }
            await loadData();
        } catch (e) {
            console.error(e);
            alert("Erro ao processar as pendências.");
        } finally {
            setIsUploading(false);
        }
    };

    const handleBatchUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            processFiles(Array.from(e.target.files));
        }
    };

    const handleIndividualUpload = (e: React.ChangeEvent<HTMLInputElement>, compId: number) => {
        if (e.target.files && e.target.files.length > 0) {
            processFiles(Array.from(e.target.files), compId);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-800">Relatório de Pendências da Receita Federal</h1>
                    <p className="text-gray-500">Faça o upload do relatório da Receita e extrairemos a lista de pendências.</p>
                </div>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-semibold text-gray-700">Upload em Lote</h3>
                    <p className="text-sm text-gray-500">O sistema mapeará o arquivo para a empresa correspondente automaticamente.</p>
                </div>
                <label className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition cursor-pointer flex items-center gap-2">
                    {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <UploadIcon className="w-5 h-5" />}
                    Selecionar PDFs
                    <input type="file" multiple accept=".pdf" className="hidden" onChange={handleBatchUpload} disabled={isUploading || isLoading} />
                </label>
            </div>

            {isLoading ? (
                <div className="flex justify-center p-10"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
            ) : (
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 border-b border-gray-100 uppercase text-xs font-semibold text-gray-500">
                                <th className="p-4">Empresa / Cliente</th>
                                <th className="p-4">Status de Pendência</th>
                                <th className="p-4 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pendenciesData.map((item) => (
                                <tr key={item.id} className="border-b border-gray-50 hover:bg-slate-50/50 transition">
                                    <td className="p-4">
                                        <p className="font-semibold text-slate-800">{item.name}</p>
                                        <p className="text-xs text-slate-500">{item.docNumber}</p>
                                    </td>
                                    <td className="p-4">
                                        {item.hasPendencies ? (
                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium">
                                                <div className="w-1.5 h-1.5 bg-red-500 rounded-full"></div>
                                                Pendências Identificadas
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-medium">
                                                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full"></div>
                                                Sem relatório processado
                                            </span>
                                        )}
                                    </td>
                                    <td className="p-4 text-right space-x-2">
                                        <label className="inline-flex items-center gap-2 px-3 py-1.5 border border-blue-200 text-blue-600 rounded hover:bg-blue-50 cursor-pointer text-sm font-medium transition cursor-pointer">
                                            <UploadIcon className="w-4 h-4" />
                                            <span className="hidden sm:inline">Upload</span>
                                            <input type="file" accept=".pdf" className="hidden" onChange={(e) => handleIndividualUpload(e, item.id)} disabled={isUploading} />
                                        </label>
                                        <button 
                                            disabled={!item.hasPendencies}
                                            onClick={() => setSelectedPendencies({name: item.name, list: item.pendencies})}
                                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-100 text-slate-700 border border-slate-200 rounded hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition"
                                            title="Ver Detalhamentos"
                                        >
                                            <Info className="w-4 h-4" />
                                            <span className="hidden sm:inline">Detalhes</span>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Modal Detalhamentos */}
            {selectedPendencies && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white max-w-2xl w-full rounded-xl shadow-2xl flex flex-col max-h-[85vh]">
                        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50 rounded-t-xl">
                            <h2 className="text-lg font-bold text-gray-800">Pendências Ocultas - {selectedPendencies.name}</h2>
                            <button onClick={() => setSelectedPendencies(null)} className="text-gray-400 hover:text-gray-600 transition"><X className="w-6 h-6" /></button>
                        </div>
                        <div className="px-6 py-6 overflow-y-auto">
                            {selectedPendencies.list.length > 0 ? (
                                <ul className="space-y-3">
                                    {selectedPendencies.list.map((pend, i) => (
                                        <li key={i} className="flex gap-3 text-red-800 bg-red-50 px-4 py-3 rounded-lg border border-red-100">
                                            <AlertIcon />
                                            <p className="text-sm font-medium leading-relaxed">{pend}</p>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-center text-gray-500 py-10">Nenhuma pendência encontrada no relatório mapeado.</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

const AlertIcon = () => (
    <svg className="w-5 h-5 shrink-0 text-red-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
);
