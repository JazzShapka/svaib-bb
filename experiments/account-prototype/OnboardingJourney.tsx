import { useId } from 'react';
import './onboarding-journey.css';

export type SetupStep = {
  id: string;
  title: string;
  detail: string;
  state: 'done' | 'current' | 'upcoming' | 'unknown';
  doneLabel?: string;
};

export type NextStep = {
  id: string;
  title: string;
  state: 'next' | 'upcoming' | 'waiting' | 'deferred' | 'unverified';
};

export type OnboardingJourneyProps = {
  setup: SetupStep[];
  setupComplete: boolean;
  nextSteps: NextStep[];
  stagesAvailable?: boolean;
  onContinue: (stepId: string) => void;
  busy?: boolean;
};

const setupLabels: Record<SetupStep['state'], string> = {
  done: 'Готово',
  current: 'Сейчас',
  upcoming: 'Предстоит',
  unknown: 'Не проверено',
};

const nextLabels: Record<NextStep['state'], string> = {
  next: 'Следующий шаг',
  upcoming: 'Предстоит',
  waiting: 'Ожидает',
  deferred: 'Отложено',
  unverified: 'Не проверено',
};

export function OnboardingJourney({ setup, setupComplete, nextSteps, stagesAvailable = false, onContinue, busy = false }: OnboardingJourneyProps) {
  const headingId = useId();
  const currentId = setup.find(step => step.state === 'current')?.id;
  const visibleNext = nextSteps.slice(0, 3);
  const nextId = (visibleNext.find(step => step.state === 'next') ??
    visibleNext.find(step => step.state !== 'upcoming'))?.id;

  const setupList = <ol className="svaib-journey-list">
    {setup.map((step, index) => <li key={step.id} className={`svaib-journey-step svaib-journey-step--${step.state}`}>
      <span className="svaib-journey-number" aria-hidden="true">{step.state === 'done' ? '✓' : index + 1}</span>
      <div className="svaib-journey-copy">
        <div className="svaib-journey-step-header"><h3>{step.title}</h3><span className="svaib-journey-status">{step.state === 'done' ? step.doneLabel ?? setupLabels.done : setupLabels[step.state]}</span></div>
        <p>{step.detail}</p>
        {!setupComplete && step.id === currentId && <button type="button" className="svaib-journey-action" disabled={busy} onClick={() => onContinue(step.id)}>Продолжить</button>}
      </div>
    </li>)}
  </ol>;

  return <section className="svaib-journey" aria-labelledby={headingId}>
    <div className="svaib-journey-header"><div><p className="svaib-journey-eyebrow">svaib</p><h2 id={headingId}>Твой путь</h2></div></div>
    {setupComplete ? <>
      <details className="svaib-journey-complete">
        <summary><span><span className="svaib-journey-complete-mark" aria-hidden="true">✓</span> Подготовка завершена</span><span className="svaib-journey-details-label"><span className="svaib-journey-when-closed">Показать шаги</span><span className="svaib-journey-when-open">Свернуть</span></span></summary>
        {setupList}
      </details>
      <div className="svaib-journey-next">
        <h3>Что дальше</h3>
        {visibleNext.length ? <ol className="svaib-journey-next-list">
          {visibleNext.map(step => <li key={step.id} className="svaib-journey-next-step">
            <div><strong>{step.title}</strong><span className="svaib-journey-status">{nextLabels[step.state]}</span></div>
            {step.id === nextId && <button type="button" className="svaib-journey-action" disabled={busy} onClick={() => onContinue(step.id)}>Продолжить</button>}
          </li>)}
        </ol> : stagesAvailable ? <p className="svaib-journey-empty">Все подходящие этапы пройдены.</p> : <>
          <p className="svaib-journey-empty">Следующие шаги пока не удалось проверить. Партнёр поможет продолжить.</p>
          <button type="button" className="svaib-journey-action" disabled={busy} onClick={() => onContinue('continue')}>Продолжить</button>
        </>}
        {visibleNext.length > 0 && !nextId && <button type="button" className="svaib-journey-action" disabled={busy} onClick={() => onContinue('continue')}>Продолжить</button>}
      </div>
    </> : <>
      <p className="svaib-journey-intro">Подготовим всё для работы с партнёром — шаг за шагом.</p>
      {setupList}
    </>}
  </section>;
}
