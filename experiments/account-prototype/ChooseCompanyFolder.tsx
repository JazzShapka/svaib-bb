/** Guidance sits in BB's native composer; BB owns the actual folder picker. */
export function CompanyFolderGuidance() {
  return <div role="note" aria-label="Как выбрать папку компании">
    <strong>Сначала выбери постоянную папку компании.</strong>
    <p>Под полем сообщения нажми <strong>No project → New project</strong>. В окне <strong>Add project</strong> выбери существующую папку или создай новую значком новой папки, затем нажми <strong>Add project</strong>. Если папка уже есть в списке проектов, просто выбери её.</p>
    <p>Оставь <strong>Project checkout</strong> — BB будет работать прямо с этой папкой. Git и выбор ветки не нужны. Затем отправь подготовленное сообщение один раз. Без постоянной папки настройка не продолжится и файлы не изменятся.</p>
  </div>;
}
