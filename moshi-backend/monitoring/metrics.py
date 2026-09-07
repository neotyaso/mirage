class MetricsReporter:
    def print_report(self, stats: dict) -> None:
        print("=" * 40)
        print("Latency Report")
        print("=" * 40)
        for k, v in stats.items():
            if isinstance(v, float):
                print(f"  {k:24s}: {v:.1f} ms")
            else:
                print(f"  {k:24s}: {v}")