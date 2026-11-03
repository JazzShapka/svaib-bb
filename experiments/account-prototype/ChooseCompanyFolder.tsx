/** Guidance sits in BB's native composer; BB owns the actual folder picker. */
export function CompanyFolderGuidance() {
  return <div role="note" aria-label="Как выбрать папку компании">
    <strong>Сначала выбери постоянную папку компании.</strong>
    <p>В новом разговоре BB открой <strong>No project → New project</strong>, выбери существующую папку или создай новую и подтверди <strong>Add project</strong>. Если папка уже подключена к BB, просто выбери существующий проект.</p>
    <p>Затем отправь подготовленное сообщение. Без постоянной папки настройка не продолжится и файлы не изменятся.</p>
  </div>;
}
