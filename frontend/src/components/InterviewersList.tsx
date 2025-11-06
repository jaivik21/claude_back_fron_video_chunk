import { useEffect, useState } from 'react';
import { Plus, Info } from 'lucide-react';
import { getApiHeaders } from '../utils/api';

interface Props { apiBaseUrl: string }

interface Interviewer {
  id: string;
  name: string;
  accent: string | null;
  elevenlabs_voice_id: string | null;
  is_active: boolean;
}

export default function InterviewersList({ apiBaseUrl }: Props) {
  const [items, setItems] = useState<Interviewer[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadInterviewers();
  }, [apiBaseUrl]);

  const loadInterviewers = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/interviewer/list-interviewers`, {
        headers: getApiHeaders(false),
      }).then(r => r.json());
      if (res?.ok) setItems(res.interviewers || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  const go = (url: string) => {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const handleCardClick = (interviewer: Interviewer) => {
    // Navigate to edit/create page with interviewer data
    go(`/interviewers/${interviewer.id}`);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Interviewers</h1>
          <p className="text-gray-600">Get to know them by clicking the profile.</p>
        </div>
        <button 
          onClick={() => go('/interviewers/create')} 
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Create Interviewer
        </button>
      </div>

      {loading && <div>Loading...</div>}
      {error && <div className="text-red-700">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {items.map((it) => (
          <div 
            key={it.id} 
            className="bg-white rounded-lg border border-gray-200 p-6 cursor-pointer hover:shadow-lg transition-shadow relative"
            onClick={() => handleCardClick(it)}
          >
            
            <div className="text-center">
              <h3 className="text-lg font-semibold mb-1">{it.name}</h3>
              {it.accent && (
                <p className="text-xs text-gray-500">{it.accent} accent</p>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCardClick(it);
              }}
              className="absolute top-2 right-2 p-1.5 text-gray-400 hover:text-blue-600 rounded transition-colors"
              title="View details"
            >
              <Info className="w-4 h-4" />
            </button>
          </div>
        ))}
        {(!loading && items.length === 0) && (
          <div className="col-span-full text-center text-gray-600 py-12">
            No interviewers yet. Click "Create Interviewer" to add one.
          </div>
        )}
      </div>
    </div>
  );
}

