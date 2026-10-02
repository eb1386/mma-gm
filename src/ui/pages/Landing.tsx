import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '@core/types/common';
import { listSaves, loadGame, renameSave, saveGame, updateIndexEntry } from '@core/save/store';
import type { SaveGame, SaveIndexEntry } from '@core/types/save';
import { summarizeCareer, type CareerSummary } from '@core/save/summary';
import { CAREER_STATE_LABEL, careerStatus } from '@core/world/career';
import { Notice, OctagonMark, Panel } from '../components';
import { GAME_NAME } from '@core/config/branding';
import { deleteCareer, useGame } from '../store';
import { StorageNotice } from '../StorageNotice';

/** How each mode reads on a card. The raw ids ('fighter', 'coach') were shown as they were. */
export const MODE_LABEL: Record<SaveIndexEntry['mode'], string> = {
  fighter: 'Fighter',
  coach: 'Coach',
  spectator: 'Spectator',
};

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
  const mutate = useGame((s) => s.mutate);
  const persist = useGame((s) => s.persist);
  const showToast = useGame((s) => s.showToast);
  const [entries, setEntries] = useState<SaveIndexEntry[]>([]);
  const [summaries, setSummaries] = useState<Record<string, CareerSummary>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  // The field opens where the browser decides to scroll it, which on a phone was under the fixed
  // header. It is brought to the middle of the screen instead.
  useEffect(() => {
    if (!renaming) return;
    const input = renameInput.current;
    if (!input) return;
    input.focus();
    input.select();
    input.scrollIntoView?.({ block: 'center' });
  }, [renaming]);

  /**
   * The cards draw from the save index alone. Each entry carries its own summary, written with the
   * save, so no full save is read here. An entry an older build wrote has none: that save is read
   * once and its entry filled in, so the next visit needs nothing.
   */
  const refresh = async () => {
    try {
      const list = await listSaves();
      setEntries(list);
      const next: Record<string, CareerSummary> = {};
      for (const entry of list) if (entry.summary) next[entry.saveId] = entry.summary;
      setSummaries(next);
      for (const entry of list) {
        if (entry.summary || entry.saveId === useGame.getState().save?.saveId) continue;
        try {
          const save = await loadGame(entry.saveId);
          if (!save) continue;
          const filled = await updateIndexEntry(save);
          if (filled.summary) setSummaries((prev) => ({ ...prev, [entry.saveId]: filled.summary! }));
        } catch {
          // A save that will not open is still listed, just without detail.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const resume = async (saveId: string) => {
    setError(null);
    // The career already loaded is the newest copy there is. Reading it back from storage threw
    // away whatever was still waiting for its write, and the last advance's recap with it.
    if (activeSave?.saveId === saveId) {
      navigate(destinationFor(activeSave));
      return;
    }
    setBusyId(saveId);
    try {
      const save = await loadGame(saveId);
      if (!save) throw new Error('That career could not be read.');
      setSave(save);
      navigate(destinationFor(save));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (saveId: string) => {
    setBusyId(saveId);
    setError(null);
    try {
      // The loaded career is copied from memory, which is newer than its stored copy.
      const source = activeSave?.saveId === saveId ? activeSave : await loadGame(saveId);
      if (!source) throw new Error('That career could not be read.');
      const copy = structuredClone(source);
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
    const name = renameValue.trim();
    if (!name) return;
    setBusyId(saveId);
    setError(null);
    try {
      if (activeSave?.saveId === saveId) {
        // Renamed in memory and written from there. Loading the stored copy and swapping it in
        // flushed the old name over the new one and dropped any change still waiting to be written.
        mutate((s) => {
          s.saveName = name;
        });
        await persist();
      } else {
        await renameSave(saveId, name);
      }
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
    setError(null);
    try {
      await deleteCareer(saveId);
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
      <StorageNotice />

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
              const isActive = activeSave?.saveId === entry.saveId;
              // The loaded career is described from memory, so its card is never behind the game.
              const summary = isActive && activeSave ? summarizeCareer(activeSave) : summaries[entry.saveId];
              const name = isActive && activeSave ? activeSave.saveName : entry.saveName;
              const isRenaming = renaming === entry.saveId;
              const fighterCareer = entry.mode === 'fighter';
              return (
                <div key={entry.saveId} className={`save-card${isActive ? ' active' : ''}`}>
                  <div className="save-card-head">
                    {isRenaming ? (
                      <input
                        ref={renameInput}
                        className="save-card-rename"
                        aria-label="Career name"
                        value={renameValue}
                        maxLength={60}
                        enterKeyHint="done"
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void rename(entry.saveId);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                    ) : (
                      <strong>{name}</strong>
                    )}
                    <span className="tag">{MODE_LABEL[entry.mode] ?? entry.mode}</span>
                  </div>
                  <table className="save-card-table">
                    <tbody>
                      <tr>
                        <td>{fighterCareer ? 'Fighter' : entry.mode === 'coach' ? 'Gym' : 'Playing as'}</td>
                        <td>{entry.fighterName ?? entry.gymName ?? 'Spectator'}</td>
                      </tr>
                      <tr>
                        <td>In game date</td>
                        <td>{formatDate(isActive && activeSave ? activeSave.date : entry.date)}</td>
                      </tr>
                      <tr>
                        <td>Last played</td>
                        <td>{new Date(entry.updatedAt).toLocaleDateString()}</td>
                      </tr>
                      {summary && (
                        <>
                          <tr>
                            <td>Career state</td>
                            <td>
                              {CAREER_STATE_LABEL[summary.state]}
                              {summary.stateSince ? ` since ${formatDate(summary.stateSince)}` : ''}
                            </td>
                          </tr>
                          <tr>
                            <td>Situation</td>
                            <td>{summary.reason ?? 'Not recorded'}</td>
                          </tr>
                          <tr>
                            <td>Next action</td>
                            <td>{summary.nextAction ?? 'Nothing outstanding'}</td>
                          </tr>
                          {/* A coach or spectator career has no booked fight, injury or division of
                              its own, so these rows only said 'Nobody' and 'Not applicable'. */}
                          {fighterCareer && (
                            <>
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
                                <td>{summary.suspensionUntil ? `Until ${formatDate(summary.suspensionUntil)}` : 'None'}</td>
                              </tr>
                              <tr>
                                <td>Division</td>
                                <td>{summary.division ?? 'Not recorded'}</td>
                              </tr>
                            </>
                          )}
                        </>
                      )}
                    </tbody>
                  </table>
                  <div className="row tight save-card-actions">
                    {isRenaming ? (
                      // Explicit buttons, because a phone has no Escape key and the field gave no
                      // other way out. Leaving the field does not commit: tapping Cancel leaves it.
                      <>
                        <button className="primary" disabled={busyId !== null || !renameValue.trim()} onClick={() => void rename(entry.saveId)}>
                          Save
                        </button>
                        <button disabled={busyId !== null} onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="primary" disabled={busyId !== null} onClick={() => void resume(entry.saveId)}>
                          Resume
                        </button>
                        <button
                          disabled={busyId !== null}
                          onClick={() => {
                            setConfirmDelete(null);
                            setRenaming(entry.saveId);
                            setRenameValue(name);
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
                      </>
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

/** Where resuming a career lands: whatever needs the player, or the dashboard when nothing does. */
function destinationFor(save: SaveGame): string {
  const status = careerStatus(save);
  return status.action && status.advanceBlocked && status.action.kind === 'navigate' ? status.action.route : '/dashboard';
}
