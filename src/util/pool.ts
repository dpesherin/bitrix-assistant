/**
 * Параллельный обход с ограничением: `limit` задач одновременно, остальные
 * ждут в очереди. Ошибка любой задачи валит весь вызов — как у `Promise.all`.
 */
export async function mapPool<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	if (items.length === 0) {
		return;
	}
	const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	let next = 0;
	const runners = Array.from({ length: width }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) {
				return;
			}
			await worker(items[index], index);
		}
	});
	await Promise.all(runners);
}
