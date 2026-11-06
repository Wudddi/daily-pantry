/** Machine date for calendar keys and form values. Never use a display locale here. */
export function canonicalLocalDate(now = new Date(), timeZone = 'America/Toronto') {
  const date = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    calendar: 'gregory', numberingSystem: 'latn', timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return [value('year')?.padStart(4, '0'), value('month'), value('day')].join('-');
}
