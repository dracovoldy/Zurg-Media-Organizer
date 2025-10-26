import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

export default function EditPage(){
  const router = useRouter();
  const { id } = router.query;
  const [dir, setDir] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(()=>{
    if (!id) return;
    setLoading(true);
    fetch(`http://localhost:4004/api/directory/${id}`)
      .then(r => { if (!r.ok) throw new Error('Not found'); return r.json(); })
      .then(j => setDir(j))
      .catch(e => setMessage(e.message))
      .finally(()=>setLoading(false));
  }, [id]);

  async function postAction(path){
    setMessage('');
    try{
      const res = await fetch(`http://localhost:4004${path}`, { method: 'POST' });
      const j = await res.json().catch(()=>({}));
      setMessage(JSON.stringify(j));
    }catch(e){ setMessage(e.message); }
  }

  if (loading) return <div style={{ padding: '1rem' }}>Loading...</div>;
  if (!dir) return <div style={{ padding: '1rem', color: 'var(--error)' }}>Directory not found</div>;

  return (
    <div style={{ padding: '1rem', maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ color: 'var(--accent)' }}>Edit: {dir.name}</h1>
      <div className="directory">
        <div><strong>Parsed:</strong> {dir.parsedName || '—'}</div>
        <div><strong>Type:</strong> {dir.parsedType || '—'}</div>
        <div><strong>Year:</strong> {dir.parsedYear || '—'}</div>
        <div><strong>TMDB:</strong> {dir.tmdbId || '—'} <em style={{ color: 'var(--text-secondary)' }}>{dir.tmdbStatus || ''}</em></div>
        <div style={{ marginTop: '1rem' }} className="action-buttons">
          <button className="btn btn-edit" onClick={()=>postAction(`/directory/${id}/parse`)}>Parse</button>
          <button className="btn" onClick={()=>postAction(`/directory/${id}/update-tmdb`)}>Update TMDB</button>
          <button className="btn" onClick={()=>postAction(`/directory/${id}/check-explicit`)}>Check Explicit</button>
          <button className="btn" onClick={()=>postAction(`/directory/${id}/mark-explicit`)}>Mark Explicit</button>
          <button className="btn" onClick={()=>postAction(`/directory/${id}/clear-explicit`)}>Clear Explicit</button>
          <button className="btn" onClick={()=>postAction(`/directory/${id}/delete`)}>Delete</button>
        </div>
        <div className="files" style={{ marginTop: '1rem' }}>
          <strong>Files</strong>
          {dir.files && dir.files.length ? dir.files.map(f=> (
            <div className="filename" key={f.id}>{f.name} — {(f.size||0).toLocaleString()} bytes</div>
          )) : <div className="filename">No files</div>}
        </div>
        <div style={{ marginTop: '1rem' }}>
          <strong>Library Path:</strong> {dir.libraryPath || 'Not in library'}
        </div>
        {message && <div style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}><strong>Result:</strong> <pre style={{ whiteSpace: 'pre-wrap' }}>{message}</pre></div>}
      </div>
    </div>
  );
}
