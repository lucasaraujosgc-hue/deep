import React, { useState, useEffect } from 'react';
import { Save, Check, Upload, Building, Loader2 } from 'lucide-react';
import { api } from '../services/api';

export const SerproSettings: React.FC = () => {
    const [config, setConfig] = useState({ isConfigured: false, consumerKey: '', cnpjContratante: '', isProduction: false });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState(false);
    
    const [certFile, setCertFile] = useState<File | null>(null);
    const [certSenha, setCertSenha] = useState('');
    const [consumerKey, setConsumerKey] = useState('');
    const [consumerSecret, setConsumerSecret] = useState('');
    const [cnpjContratante, setCnpjContratante] = useState('');
    const [isProduction, setIsProduction] = useState(false);

    useEffect(() => {
        api.get('/pendencies/serpro/config').then(res => {
            if (res.success && res.config) {
                setConfig(res.config);
                if (res.config.consumerKey) setConsumerKey(res.config.consumerKey);
                if (res.config.cnpjContratante) setCnpjContratante(res.config.cnpjContratante);
                setIsProduction(res.config.isProduction);
            }
            setLoading(false);
        }).catch(err => {
            setLoading(false);
        });
    }, []);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            const formData = new FormData();
            if (certFile) formData.append('certFile', certFile);
            formData.append('certSenha', certSenha);
            formData.append('consumerKey', consumerKey);
            formData.append('consumerSecret', consumerSecret);
            formData.append('cnpjContratante', cnpjContratante);
            formData.append('isProduction', isProduction ? 'true' : 'false');

            const result = await api.postRaw('/pendencies/serpro/config', formData, true); // true for multipart
            if (result.success) {
                setSuccess(true);
                setConfig({ ...config, isConfigured: true });
                setCertSenha('');
                setConsumerSecret('');
                setTimeout(() => setSuccess(false), 3000);
            } else {
                alert(result.error || 'Erro ao salvar');
            }
        } catch(e: any) {
            alert('Erro: ' + e.message);
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="text-sm text-slate-500">Carregando configurações...</div>;

    return (
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-6 border-b border-slate-100 bg-slate-50">
            <h3 className="text-lg font-semibold text-slate-800 flex items-center">
              <Building className="w-5 h-5 mr-2 text-blue-600" />
              Integra Contador SERPRO (Situação Fiscal)
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Configure as credenciais do SERPRO para emitir Relatório de Situação Fiscal automaticamente.
            </p>
          </div>

          <div className="p-6">
            {config.isConfigured && (
                <div className="mb-6 p-4 bg-green-50 text-green-700 rounded-lg flex items-center">
                    <Check className="w-5 h-5 mr-2" />
                    <div>
                        <p className="font-medium">Certificado e Integração configurados.</p>
                        <p className="text-xs mt-1 text-green-600">Apenas informe os dados abaixo novamente se desejar atualizar (os campos de senha e secret não são exibidos por segurança).</p>
                    </div>
                </div>
            )}

            <form onSubmit={handleSave} className="space-y-6 max-w-2xl">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                            Ambiente
                        </label>
                        <select
                            value={isProduction ? 'true' : 'false'}
                            onChange={e => setIsProduction(e.target.value === 'true')}
                            className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        >
                            <option value="false">Homologação (Trial / Grátis)</option>
                            <option value="true">Produção</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                            CNPJ do Escritório Contratante
                        </label>
                        <input
                            type="text"
                            value={cnpjContratante}
                            onChange={e => setCnpjContratante(e.target.value)}
                            required
                            placeholder="00.000.000/0001-00"
                            className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                         <label className="block text-sm font-medium text-slate-700 mb-1">
                            Consumer Key (SERPRO) {isProduction && '*'}
                         </label>
                         <input
                            type="text"
                            value={consumerKey}
                            onChange={e => setConsumerKey(e.target.value)}
                            required={isProduction}
                            placeholder="Chave Pública do Contrato"
                            className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                    </div>
                    <div>
                         <label className="block text-sm font-medium text-slate-700 mb-1">
                            Consumer Secret (SERPRO) {!config.isConfigured && isProduction ? '*' : ''}
                         </label>
                         <input
                            type="password"
                            value={consumerSecret}
                            onChange={e => setConsumerSecret(e.target.value)}
                            required={!config.isConfigured && isProduction}
                            placeholder={config.isConfigured ? 'Deixe em branco para manter' : 'Secret do Contrato'}
                            className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                         <label className="block text-sm font-medium text-slate-700 mb-1">
                            Certificado Digital (.pfx ou .p12) {!config.isConfigured && isProduction ? '*' : ''}
                         </label>
                         <div className="flex items-center">
                            <label className="cursor-pointer bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors flex flex-1 items-center justify-center">
                                <Upload className="w-4 h-4 mr-2" />
                                {certFile ? certFile.name : 'Selecionar Arquivo'}
                                <input
                                    type="file"
                                    accept=".pfx,.p12"
                                    className="hidden"
                                    onChange={e => setCertFile(e.target.files ? e.target.files[0] : null)}
                                />
                            </label>
                         </div>
                    </div>
                    <div>
                         <label className="block text-sm font-medium text-slate-700 mb-1">
                            Senha do Certificado {!config.isConfigured && isProduction ? '*' : ''}
                         </label>
                         <input
                            type="password"
                            value={certSenha}
                            onChange={e => setCertSenha(e.target.value)}
                            required={!config.isConfigured && isProduction}
                            placeholder={config.isConfigured ? 'Deixe em branco para manter' : 'Senha do e-CNPJ'}
                            className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                    </div>
                </div>
                
                <div className="flex justify-end pt-4 border-t border-slate-100">
                    <button
                        type="submit"
                        disabled={saving}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors flex items-center"
                    >
                        {saving ? (
                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Salvando...</>
                        ) : success ? (
                            <><Check className="w-4 h-4 mr-2" /> Salvo com Sucesso</>
                        ) : (
                            <><Save className="w-4 h-4 mr-2" /> Salvar Configuração</>
                        )}
                    </button>
                </div>
            </form>
          </div>
        </div>
    );
};
