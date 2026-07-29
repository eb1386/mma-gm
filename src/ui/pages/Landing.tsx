import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '@core/types/common';
import { deleteSave, listSaves, loadGame, saveGame } from '@core/save/store';
import type { SaveIndexEntry } from '@core/types/save';
import { migrateSave } from '@core/save/migrate';
import { CAREER_STATE_LABEL, careerStatus, type CareerState } from '@core/world/career';
import type { SaveGame } from '@core/types/save';
import { Notice, OctagonMark, Panel } from '../components';
import { GAME_NAME } from '@core/config/branding';
import { useGame } from '../store';

/**
 * The landing screen.
 *
 * It lives outside the career shell and never creates or resets a world by itself. Opening
 * it from the brand mark is always safe: the active career is untouched until the player
 * explicitly resumes, duplicates, renames or deletes something.
 */
export function LandingPage() {
  const navigate = useNavigate();
  const setSave = useGame((s) => s.setSave);
  const activeSave = useGame((s) => s.save);
  const showToast = useGame((s) => s.showToast);
  const [entries, setEntries] = useState<SaveIndexEntry[]>([]);
  const [summaries, setSummaries] = useState<Record<string, CareerSummary>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    try {
      const list = await listSaves();
      setEntries(list);
      // Read each save once so the card can show the real career state.
      const next: Record<string, CareerSummary> = {};
      for (const entry of list) {
        try {
          const raw = await loadGame(entry.saveId);
          if (!raw) continue;
          const save = migrateSave(raw);
          next[entry.saveId] = summarize(save);
        } catch {
          // A save that will not open is still listed, just without detail.
        }
      }
      setSummaries(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const resume = async (saveId: string) => {
    setBusyId(saveId);
    setError(null);
    try {
      const raw = await loadGame(saveId);
      if (!raw) throw new Error('That career could not be read.');
      const save = migrateSave(raw);
      setSave(save);
      // Land on whatever needs the player, or the dashboard when nothing does.
      const status = careerStatus(save);
      const destination =
        status.action && status.advanceBlocked && status.action.kind === 'navigate' ? status.action.route : '/dashboard';
      navigate(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (saveId: string) => {
    setBusyId(saveId);
    try {
      const raw = await loadGame(saveId);
      if (!raw) throw new Error('That career could not be read.');
      const copy = migrateSave(JSON.parse(JSON.stringify(raw)) as SaveGame);
      copy.saveId = `save-copy-${Date.now().toString(36)}`;
      copy.saveName = `${copy.saveName} (copy)`;
      await saveGame(copy);
      showToast(`Copied ${copy.saveName}.`, 'good');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (saveId: string) => {
    if (!renameValue.trim()) return;
    setBusyId(saveId);
    try {
      const raw = await loadGame(saveId);
      if (!raw) throw new Error('That career could not be read.');
      const save = migrateSave(raw);
      save.saveName = renameValue.trim();
      await saveGame(save);
      if (activeSave?.saveId === saveId) setSave(save);
      setRenaming(null);
      showToast('Career renamed.', 'good');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (saveId: string) => {
    setBusyId(saveId);
    try {
      await deleteSave(saveId);
      if (activeSave?.saveId === saveId) setSave(null);
      setConfirmDelete(null);
      showToast('Career deleted.', 'info');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const mostRecent = entries[0] ?? null;

  return (
    <div className="landing">
      <div className="landing-head">
        <OctagonMark size={44} />
        <div>
          <h1>{GAME_NAME}</h1>
          <p className="dim">Your careers and worlds.</p>
        </div>
      </div>

      {error && <Notice kind="bad">{error}</Notice>}

      <div className="row landing-actions">
        {mostRecent && (
          <button className="primary" disabled={busyId !== null} onClick={() => void resume(mostRecent.saveId)}>
            Resume {mostRecent.saveName}
          </button>
        )}
        <button onClick={() => navigate('/new')}>Create a New World</button>
        <button onClick={() => navigate('/load')}>Import a Career</button>
        {activeSave && <button onClick={() => navigate('/dashboard')}>Back to the Current Career</button>}
      </div>

      <Panel title={entries.length === 0 ? 'No careers yet' : `${entries.length} career${entries.length === 1 ? '' : 's'}`}>
        {entries.length === 0 ? (
          <p className="dim">
            Nothing is saved yet. Creating a new world will not overwrite anything, because there is nothing to
            overwrite.
          </p>
        ) : (
          <div className="save-grid">
            {entries.map((entry) => {
              const summary = summaries[entry.saveId];
              return (
                <div key={entry.saveId} className={`save-card${activeSave?.saveId === entry.saveId ? ' active' : ''}`}>
                  <div className="save-card-head">
                    {renaming === entry.saveId ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void rename(entry.saveId);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                    ) : (
                      <strong>{entry.saveName}</strong>
                    )}
                    <span className="tag">{entry.mode}</span>
                  </div>
                  <table className="save-card-table">
                    <tbody>
                      <tr>
                        <td>Fighter or gym</td>
                        <td>{entry.fighterName ?? entry.gymName ?? 'Spectator'}</td>
                      </tr>
                      <tr>
                        <td>In game date</td>
                        <td>{formatDate(entry.date)}</td>
                      </tr>
                      <tr>
                        <td>Last played</td>
                        <td>{new Date(entry.updatedAt).toLocaleDateString()}</td>
                      </tr>
                      {summary && (
                        <>
                          <tr>
                            <td>Career state</td>
                            <td>{CAREER_STATE_LABEL[summary.state]}</td>
                          </tr>
                          <tr>
                            <td>Next action</td>
                            <td>{summary.nextAction ?? 'Nothing outstanding'}</td>
                          </tr>
                          <tr>
                            <td>Booked opponent</td>
                            <td>{summary.opponent ?? 'Nobody'}</td>
                          </tr>
                          <tr>
                            <td>Fight date</td>
                            <td>{summary.fightDate ? formatDate(summary.fightDate) : 'None'}</td>
                          </tr>
                          <tr>
                            <td>Injury</td>
                            <td>{summary.injury ?? 'None'}</td>
                          </tr>
                          <tr>
                            <td>Suspension</td>
                            <td>{summary.suspension ?? 'None'}</td>
                          </tr>
                          <tr>
                            <td>Division</td>
                            <td>{summary.division ?? 'Not applicable'}</td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>
                  <div className="row tight save-card-actions">
                    <button className="primary" disabled={busyId !== null} onClick={() => void resume(entry.saveId)}>
                      Resume
                    </button>
                    <button
                      disabled={busyId !== null}
                      onClick={() => {
                        setRenaming(entry.saveId);
                        setRenameValue(entry.saveName);
                      }}
                    >
                      Rename
                    </button>
                    <button disabled={busyId !== null} onClick={() => void duplicate(entry.saveId)}>
                      Duplicate
                    </button>
                    {confirmDelete === entry.saveId ? (
                      <>
                        <button className="danger" disabled={busyId !== null} onClick={() => void remove(entry.saveId)}>
                          Delete permanently
                        </button>
                        <button onClick={() => setConfirmDelete(null)}>Keep it</button>
                      </>
                    ) : (
                      <button className="danger" disabled={busyId !== null} onClick={() => setConfirmDelete(entry.saveId)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

interface CareerSummary {
  state: CareerState;
  nextAction: string | null;
  opponent: string | null;
  fightDate: string | null;
  injury: string | null;
  suspension: string | null;
  division: string | null;
}

function summarize(save: SaveGame): CareerSummary {
  const status = careerStatus(save);
  const me = save.player.fighterId ? save.fighters[save.player.fighterId] : null;
  const suspension =
    me?.antiDopingSuspension?.until ?? me?.medicalSuspension?.until ?? me?.commissionSuspension?.until ?? null;
  return {
    state: status.state,
    nextAction: status.action?.label ?? null,
    opponent: status.opponentName,
    fightDate: status.eventDate,
    injury: status.injurySummary,
    suspension: suspension ? `Until ${suspension}` : null,
    division: me?.divisionId ?? null,
  };
}
