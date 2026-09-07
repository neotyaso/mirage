"""pynvml / nvidia-ml-py 両対応"""


def get_vram_mb() -> tuple[int, int]:
    try:
        import pynvml
        pynvml.nvmlInit()
        h = pynvml.nvmlDeviceGetHandleByIndex(0)
        info = pynvml.nvmlDeviceGetMemoryInfo(h)
        return info.used // 1024**2, info.total // 1024**2
    except ImportError:
        try:
            import nvidia_ml_py3 as nv
            nv.nvmlInit()
            h = nv.nvmlDeviceGetHandleByIndex(0)
            info = nv.nvmlDeviceGetMemoryInfo(h)
            return info.used // 1024**2, info.total // 1024**2
        except ImportError:
            return (0, 0)


def get_gpu_name() -> str:
    try:
        import pynvml
        pynvml.nvmlInit()
        return pynvml.nvmlDeviceGetName(pynvml.nvmlDeviceGetHandleByIndex(0)).decode()
    except Exception:
        return "unknown"