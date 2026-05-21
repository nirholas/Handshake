import { useEffect, useState } from 'react';
import { getGPUTier, TierResult as GpuTierResult } from 'detect-gpu';
import { stringify } from 'qs';
import { checkDownloadSpeed } from 'src/services/DownloadSpeed.service';
import { trackEvent } from 'src/services/Analytics.service';

type TierPresets = { [key: number]: Record<string, any> };

const TIER_PRESETS: TierPresets = {
  1: {
    quality: 'low'
  },
  2: {
    quality: 'medium'
  },
  3: {
    quality: 'high'
  }
};

type NetworkTierResult = {
  downloadSpeed: number;
  tier: number;
};

// in mbps
const networkTierGrades = {
  1: 0.7,
  2: 2,
  3: Infinity
};

type DeviceDetectorServiceProps = {
  gpuTierResult: GpuTierResult;
  networkTierResult: NetworkTierResult;
  tierPresets?: TierPresets;
};

class DeviceDetectorService {
  private tierPresets: TierPresets = TIER_PRESETS;

  private gpuTierResult: GpuTierResult;

  private networkTierResult: NetworkTierResult;

  constructor(props: DeviceDetectorServiceProps) {
    this.gpuTierResult = props.gpuTierResult;
    this.networkTierResult = props.networkTierResult;
    if (props.tierPresets) {
      this.tierPresets = { ...TIER_PRESETS, ...props.tierPresets };
    }

    trackEvent('device detected', this.result);
  }

  get result() {
    return {
      gpu: this.gpuTierResult,
      network: this.networkTierResult
    };
  }

  toQueryString() {
    return stringify(this.tierPresets[Math.min(this.gpuTierResult.tier, this.networkTierResult.tier)]);
  }
}

export type DeviceDetectorHookProps = {
  tierPresets?: TierPresets;
};

export function useDeviceDetector(options?: DeviceDetectorHookProps) {
  const [deviceDetector, setDeviceDetector] = useState<DeviceDetectorService>();

  useEffect(() => {
    const fetchDeviceDetector = async () => {
      let gpuTierResult: GpuTierResult = { type: 'BENCHMARK', tier: 3 };
      let networkTierResult: NetworkTierResult = { downloadSpeed: 100, tier: 3 };
      try {
        gpuTierResult = await getGPUTier();
        // Safari fails to detect the GPU tier, so we set it to the highest tier
        if (gpuTierResult.type !== 'BENCHMARK') {
          gpuTierResult.tier = 3;
        }

        const downloadSpeed = await checkDownloadSpeed('https://assets.three.ws/benchmark.glb');

        let tier = 3;
        if (downloadSpeed < networkTierGrades[1]) {
          tier = 1;
        } else if (downloadSpeed < networkTierGrades[2]) {
          tier = 2;
        }

        networkTierResult = {
          downloadSpeed,
          tier
        };
      } catch (error) {
        console.error(error);
      }

      setDeviceDetector(new DeviceDetectorService({ gpuTierResult, networkTierResult, ...options }));
    };
    fetchDeviceDetector();
  }, []);

  return deviceDetector;
}
