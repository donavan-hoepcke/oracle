export interface AlertEvent {
  symbol: string;
  currentPrice: number;
  targetPrice: number;
  timestamp: Date;
}

class AlertService {
  private alertedSymbols: Set<string> = new Set();

  hasAlerted(symbol: string): boolean {
    return this.alertedSymbols.has(symbol);
  }

  recordAlert(symbol: string): void {
    this.alertedSymbols.add(symbol);
  }

  resetAlerts(): void {
    this.alertedSymbols.clear();
  }

  getAlertedSymbols(): string[] {
    return Array.from(this.alertedSymbols);
  }
}

export const alertService = new AlertService();
