import React, { useState, useEffect } from 'react';
import { Task, TaskStatus, TaskPriority } from '../types';
import { api } from '../services/api';
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area, CartesianGrid, Legend
} from 'recharts';
import { Plus, Edit2, Trash2, CheckCircle2, Circle, Clock, ChevronDown, ChevronRight, X, LayoutGrid, List as ListIcon, Calendar, Activity, AlertTriangle, Layers, Tag, ChevronLeft } from 'lucide-react';
import { format, parseISO, isPast, isToday, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import ReactMarkdown from 'react-markdown';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

export default function TaskManagementDashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set());
  const [selectedParentId, setSelectedParentId] = useState<number | null>(null);

  // Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>(TaskStatus.PENDING);
  const [priority, setPriority] = useState<TaskPriority>(TaskPriority.MEDIUM);
  const [color, setColor] = useState('#3b82f6');
  const [dueDate, setDueDate] = useState('');
  const [estimatedTime, setEstimatedTime] = useState('');

  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
    setLoading(true);
    try {
      const data = await api.getTasks();
      setTasks(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) return;
    
    try {
      const taskData: Partial<Task> = {
        title,
        description,
        status,
        priority,
        color,
        dueDate: dueDate || undefined,
        estimatedTime: estimatedTime || undefined,
        parentId: selectedParentId || undefined,
      };
      
      if (editingTask) {
        taskData.id = editingTask.id;
      }
      
      await api.saveTask(taskData);
      closeForm();
      loadTasks();
    } catch (e) {
      console.error('Error saving task', e);
    }
  };

  const handleDeleteTask = async (id: number) => {
    if (confirm('Tem certeza que deseja excluir esta tarefa? (Subtarefas também serão afetadas)')) {
      try {
        await api.deleteTask(id);
        loadTasks();
      } catch (e) {
        console.error(e);
      }
    }
  };

  const openNewTaskForm = (parentId?: number) => {
    setEditingTask(null);
    setTitle('');
    setDescription('');
    setStatus(TaskStatus.PENDING);
    setPriority(TaskPriority.MEDIUM);
    setColor('#3b82f6');
    setDueDate('');
    setEstimatedTime('');
    setSelectedParentId(parentId || null);
    setIsFormOpen(true);
  };

  const openEditTaskForm = (task: Task) => {
    setEditingTask(task);
    setTitle(task.title);
    setDescription(task.description || '');
    setStatus(task.status);
    setPriority(task.priority);
    setColor(task.color || '#3b82f6');
    setDueDate(task.dueDate ? task.dueDate.split('T')[0] : '');
    setEstimatedTime(task.estimatedTime || '');
    setSelectedParentId(task.parentId || null);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingTask(null);
    setSelectedParentId(null);
  };

  const toggleExpand = (id: number) => {
    const newExpanded = new Set(expandedTasks);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedTasks(newExpanded);
  };

  // Analytics
  const topLevelTasks = tasks.filter(t => !t.parentId);
  
  const tasksByStatus = [
    { name: 'Pendentes', value: tasks.filter(t => t.status === TaskStatus.PENDING).length },
    { name: 'Em Andamento', value: tasks.filter(t => t.status === TaskStatus.IN_PROGRESS).length },
    { name: 'Concluídas', value: tasks.filter(t => t.status === TaskStatus.DONE).length },
  ];

  const tasksByPriority = [
    { name: 'Alta', Alta: tasks.filter(t => t.priority === TaskPriority.HIGH).length },
    { name: 'Média', Media: tasks.filter(t => t.priority === TaskPriority.MEDIUM).length },
    { name: 'Baixa', Baixa: tasks.filter(t => t.priority === TaskPriority.LOW).length },
  ];

  const overDueTasks = tasks.filter(t => t.dueDate && t.status !== TaskStatus.DONE && isPast(parseISO(t.dueDate)) && !isToday(parseISO(t.dueDate)));

  const renderTree = (parentId: number | undefined = undefined, level = 0) => {
    const children = tasks.filter(t => t.parentId === parentId);
    if (children.length === 0) return null;

    return (
      <div className="space-y-2">
        {children.map(task => (
          <div key={task.id} className="w-full">
            <div 
              className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg shadow-sm hover:border-blue-300 transition-colors ${level > 0 ? 'ml-6 sm:ml-12 border-l-4' : 'border-l-4'}`}
              style={{ borderLeftColor: task.color || '#3b82f6' }}
            >
              <div className="flex-1 flex items-center gap-3">
                <button onClick={() => toggleExpand(task.id)} className="p-1 hover:bg-gray-100 rounded text-gray-500">
                  {tasks.some(t => t.parentId === task.id) ? (
                    expandedTasks.has(task.id) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
                  ) : <Circle className="w-4 h-4 opacity-30" />}
                </button>
                <div 
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center cursor-pointer ${task.status === TaskStatus.DONE ? 'bg-green-500 border-green-500' : 'border-gray-300'}`}
                  onClick={() => api.saveTask({ id: task.id, status: task.status === TaskStatus.DONE ? TaskStatus.PENDING : TaskStatus.DONE }).then(loadTasks)}
                >
                  {task.status === TaskStatus.DONE && <CheckCircle2 className="w-3 h-3 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className={`font-semibold text-gray-800 truncate ${task.status === TaskStatus.DONE ? 'line-through text-gray-400' : ''}`}>
                    {task.title}
                  </h4>
                  {task.description && (
                    <div className="text-xs text-gray-500 truncate mt-0.5">
                      {task.description.length > 60 ? task.description.substring(0, 60) + '...' : task.description}
                    </div>
                  )}
                </div>
              </div>
              
              <div className="flex items-center gap-3 ml-11 sm:ml-0 overflow-x-auto pb-1 sm:pb-0 hide-scrollbar">
                {task.priority === TaskPriority.HIGH && <span className="flex-shrink-0 bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-semibold flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> Alta</span>}
                {task.priority === TaskPriority.MEDIUM && <span className="flex-shrink-0 bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded text-xs font-semibold flex items-center gap-1"><Activity className="w-3 h-3"/> Média</span>}
                {task.priority === TaskPriority.LOW && <span className="flex-shrink-0 bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs font-semibold flex items-center gap-1"><Layers className="w-3 h-3"/> Baixa</span>}
                
                {task.dueDate && (
                  <span className={`flex-shrink-0 flex items-center gap-1 text-xs px-2 py-0.5 rounded ${isPast(parseISO(task.dueDate)) && task.status !== TaskStatus.DONE && !isToday(parseISO(task.dueDate)) ? 'bg-red-50 text-red-600 font-medium' : 'bg-gray-100 text-gray-600'}`}>
                    <Calendar className="w-3 h-3" />
                    {format(parseISO(task.dueDate), 'dd/MM/yyyy')}
                  </span>
                )}
                {task.estimatedTime && (
                  <span className="flex-shrink-0 flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                    <Clock className="w-3 h-3" />
                    {task.estimatedTime}
                  </span>
                )}
                
                <div className="flex items-center gap-1 flex-shrink-0 border-l pl-2 ml-2">
                  <button onClick={() => openNewTaskForm(task.id)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Adicionar Subtarefa"><Plus className="w-4 h-4" /></button>
                  <button onClick={() => openEditTaskForm(task)} className="p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded" title="Editar Tarefa"><Edit2 className="w-4 h-4" /></button>
                  <button onClick={() => handleDeleteTask(task.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Excluir Tarefa"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            </div>
            
            {expandedTasks.has(task.id) && (
              <div className="mt-2">
                {renderTree(task.id, level + 1)}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 min-h-[500px]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
        <p className="text-gray-500 font-medium animate-pulse">Sincronizando tarefas...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50 overflow-y-auto">
      {/* Header Panel */}
      <div className="bg-white border-b px-6 py-5 shrink-0 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-black text-gray-800 flex items-center gap-2">
            <Layers className="w-6 h-6 text-blue-600" />
            Gestão de Tarefas
          </h2>
          <p className="text-gray-500 text-sm mt-1">Acompanhe seu progresso e gerencie sub-tarefas com facilidade.</p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => openNewTaskForm()}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" /> Nova Tarefa
          </button>
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col lg:flex-row gap-6 items-start">
        {/* Left Column: Tasks */}
        <div className="w-full lg:w-2/3 flex flex-col gap-4">
          <div className="flex justify-between items-center bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
            <h3 className="font-bold text-gray-700 flex items-center gap-2">
              <ListIcon className="w-5 h-5 text-gray-400" /> 
              Árvore de Tarefas
            </h3>
            <div className="text-sm text-gray-500 font-medium">
              {tasks.length} tarefas no total
            </div>
          </div>
          
          <div className="bg-gray-50/50 rounded-xl">
            {tasks.length > 0 ? renderTree() : (
              <div className="flex flex-col items-center justify-center p-12 text-center bg-white rounded-xl border border-dashed border-gray-300">
                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4">
                  <Layers className="w-8 h-8 text-blue-400" />
                </div>
                <h4 className="text-lg font-bold text-gray-700 mb-1">Nenhuma tarefa encontrada</h4>
                <p className="text-gray-500 mb-6 max-w-md">Crie sua primeira tarefa para começar a organizar seu fluxo de trabalho de forma hierárquica.</p>
                <button 
                  onClick={() => openNewTaskForm()}
                  className="bg-blue-50 text-blue-600 hover:bg-blue-100 px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Criar Primeira Tarefa
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Analytics & Widgets */}
        <div className="w-full lg:w-1/3 flex flex-col gap-6">
          {/* Progress Overview Card */}
          <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm">
            <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
              <Activity className="w-5 h-5 text-indigo-500" /> Status Geral
            </h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={tasksByStatus}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {tasksByStatus.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip />
                  <Legend verticalAlign="bottom" height={36}/>
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Priority Breakdown */}
          <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm">
            <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-500" /> Por Prioridade
            </h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tasksByPriority} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
                  <RechartsTooltip cursor={{fill: '#f8fafc'}} />
                  <Bar dataKey="Alta" fill="#ef4444" radius={[4, 4, 0, 0]} stackId="a" />
                  <Bar dataKey="Media" fill="#f59e0b" radius={[4, 4, 0, 0]} stackId="a" />
                  <Bar dataKey="Baixa" fill="#3b82f6" radius={[4, 4, 0, 0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Alerts */}
          {overDueTasks.length > 0 && (
            <div className="bg-red-50 border border-red-200 p-5 rounded-2xl">
              <h3 className="font-bold text-red-800 mb-2 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" /> {overDueTasks.length} Tarefa(s) Atrasada(s)
              </h3>
              <ul className="space-y-2 mt-3">
                {overDueTasks.slice(0, 3).map(t => (
                  <li key={t.id} className="text-sm text-red-700 bg-white/60 p-2 rounded flex justify-between items-center">
                    <span className="truncate flex-1 font-medium">{t.title}</span>
                    <span className="text-xs font-bold bg-red-100 px-1.5 py-0.5 rounded">{t.dueDate ? format(parseISO(t.dueDate), 'dd/MM') : ''}</span>
                  </li>
                ))}
                {overDueTasks.length > 3 && (
                  <li className="text-xs text-red-600 font-semibold text-center mt-2">+ {overDueTasks.length - 3} outras</li>
                )}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Form Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-full overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
            <div className="p-5 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                {editingTask ? <Edit2 className="w-5 h-5 text-blue-600"/> : <Plus className="w-5 h-5 text-blue-600"/>}
                {editingTask ? 'Editar Tarefa' : 'Nova Tarefa'}
                {selectedParentId && <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full ml-2">Subtarefa</span>}
              </h3>
              <button onClick={closeForm} className="p-2 text-gray-400 hover:bg-gray-200 rounded-full transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1">
              <form id="task-form" onSubmit={handleSaveTask} className="space-y-5">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">Título da Tarefa</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="Ex: Finalizar fechamento mensal..."
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
                    Descrição 
                    <span className="text-xs font-normal text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">Suporta Markdown</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg p-2.5 h-28 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono text-sm resize-y"
                    placeholder="- [ ] Passo 1&#10;- [ ] Passo 2"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">Status</label>
                    <select
                      value={status}
                      onChange={e => setStatus(e.target.value as TaskStatus)}
                      className="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value={TaskStatus.PENDING}>Pendente</option>
                      <option value={TaskStatus.IN_PROGRESS}>Em Andamento</option>
                      <option value={TaskStatus.DONE}>Concluída</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">Prioridade</label>
                    <select
                      value={priority}
                      onChange={e => setPriority(e.target.value as TaskPriority)}
                      className="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value={TaskPriority.LOW}>Baixa</option>
                      <option value={TaskPriority.MEDIUM}>Média</option>
                      <option value={TaskPriority.HIGH}>Alta</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">Vencimento</label>
                    <input
                      type="date"
                      value={dueDate}
                      onChange={e => setDueDate(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">Tempo Estimado</label>
                    <input
                      type="text"
                      value={estimatedTime}
                      onChange={e => setEstimatedTime(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-blue-500 outline-none"
                      placeholder="Ex: 2h 30m"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Cor da Etiqueta</label>
                    <div className="flex gap-2 items-center flex-wrap">
                      {COLORS.map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setColor(c)}
                          className={`w-8 h-8 rounded-full border-2 transition-transform ${color === c ? 'border-gray-800 scale-110 shadow-md' : 'border-transparent hover:scale-105'}`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </form>
            </div>
            
            <div className="p-5 border-t bg-gray-50 flex justify-end gap-3 shrink-0">
              <button 
                type="button" 
                onClick={closeForm}
                className="px-5 py-2.5 rounded-lg text-gray-700 font-medium hover:bg-gray-200 transition-colors"
              >
                Cancelar
              </button>
              <button 
                type="submit" 
                form="task-form"
                className="px-6 py-2.5 rounded-lg bg-blue-600 text-white font-bold hover:bg-blue-700 shadow-sm transition-colors flex items-center gap-2"
              >
                <CheckCircle2 className="w-5 h-5" />
                Salvar Tarefa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
