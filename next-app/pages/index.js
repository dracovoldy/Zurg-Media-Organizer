import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function Home() {
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('http://localhost:4004/api/directories');
        if (!res.ok) throw new Error('Failed to fetch directories');
        const data = await res.json();
        setDirs(data);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div>
      <main style={{ padding: '1rem' }}>
        <h1 style={{ color: 'var(--accent)', textAlign: 'center' }}>Zurg Media Organizer — Next.js UI</h1>
        <div style={{ maxWidth: 900, margin: '1rem auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div>
              <a className="btn btn-mass" href="/parse-all" onClick={async (e)=>{ e.preventDefault(); await fetch('http://localhost:4004/parse-all'); location.reload(); }}>Parse all</a>
              <a className="btn btn-mass" href="/update-all-tmdb" onClick={async (e)=>{ e.preventDefault(); await fetch('http://localhost:4004/update-all-tmdb'); location.reload(); }}>Update all TMDB</a>
            </div>
            <div>
              <span style={{ color: 'var(--text-secondary)' }}>Backend: http://localhost:4004</span>
            </div>
          </div>

          {loading && <p>Loading directories...</p>}
          {error && <p style={{ color: 'var(--error)' }}>{error}</p>}

          {dirs.map(dir => (
            <div key={dir.id} className="directory" style={{ marginBottom: '1rem' }}>
              <h2>{dir.name} {dir.parsedName ? ` — ${dir.parsedName}` : ''}</h2>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div>
                  <div><strong>Type:</strong> {dir.parsedType || 'unknown'}</div>
                  <div><strong>Year:</strong> {dir.parsedYear || '-'}</div>
                  <div><strong>TMDB:</strong> {dir.tmdbId || '—'} <em style={{ color: 'var(--text-secondary)' }}>{dir.tmdbStatus || ''}</em></div>
                  <div style={{ marginTop: '0.5rem' }}>
                    <Link href={`/edit/${dir.id}`}><a className="btn btn-edit">Edit</a></Link>
                    <a className="btn btn-toggle" href="#" style={{ marginLeft: '0.6rem' }} onClick={async (e)=>{ e.preventDefault(); await fetch(`http://localhost:4004/add-to-library/${dir.id}`, { method: 'POST' }); alert('Triggered add-to-library'); }}>Add to library</a>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="files">
                    <strong>Files:</strong>
                    {dir.files && dir.files.length ? dir.files.map(f => (
                      <div className="filename" key={f.id}>{f.name} — {(f.size || 0).toLocaleString()} bytes</div>
                    )) : <div className="filename">No files</div>}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {!loading && dirs.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No directories found.</p>}
        </div>
      </main>
    </div>
  );
}
