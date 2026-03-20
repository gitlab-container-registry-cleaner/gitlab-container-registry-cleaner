const BAR_WIDTH = 30;
const isTTY = process.stdout.isTTY ?? false;

export class ProgressBar {
	private total: number;
	private current = 0;
	private label: string;
	private extra: () => string;

	constructor(total: number, label: string, extra: () => string = () => "") {
		this.total = total;
		this.label = label;
		this.extra = extra;
	}

	update(current: number): void {
		if (!isTTY) return;
		this.current = current;
		const pct =
			this.total > 0 ? Math.round((this.current / this.total) * 100) : 0;
		const filled =
			this.total > 0 ? Math.round((this.current / this.total) * BAR_WIDTH) : 0;
		const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
		const extraStr = this.extra();
		process.stdout.write(
			`\r   ${bar} ${pct}% ${this.label} (${this.current}/${this.total}${extraStr})`,
		);
	}

	finish(): void {
		if (!isTTY) return;
		this.update(this.total);
		process.stdout.write("\n");
	}
}
