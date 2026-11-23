//! Capacités de la machine utiles au moteur local : cartes graphiques (DXGI), mémoire vive et
//! cœurs du processeur. Sert à choisir où tourne un modèle Whisper (carte NVIDIA ou processeur)
//! et à recommander celui qui convient au PC.

use serde::Serialize;

const MB: u64 = 1_000_000;

/// Mémoire graphique laissée au contexte CUDA, à cuBLAS et aux autres applications.
const GPU_RESERVED_BYTES: u64 = 700 * MB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

impl GpuVendor {
    /// Fabricant d'après son identifiant PCI (`DXGI_ADAPTER_DESC1::VendorId`).
    pub fn from_pci_id(id: u32) -> Self {
        match id {
            0x10DE => Self::Nvidia,
            0x1002 | 0x1022 => Self::Amd,
            0x8086 => Self::Intel,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vendor: GpuVendor,
    /// Mémoire graphique dédiée, en octets (faible ou nulle pour un GPU intégré).
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub gpus: Vec<GpuInfo>,
    /// Mémoire vive totale, en octets (0 si inconnue).
    pub total_memory_bytes: u64,
    pub physical_cores: usize,
    pub logical_cores: usize,
    /// Instructions AVX2 : conditionnent la vitesse de whisper.cpp sur processeur.
    pub avx2: bool,
}

/// Appareil qui exécute un modèle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    Gpu,
    Cpu,
}

/// Le modèle tient-il dans la mémoire de l'appareil qui l'exécute ?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fit {
    Ok,
    /// Tient, mais en prenant une grosse part de la mémoire vive.
    Tight,
    TooBig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub device: Device,
    pub fit: Fit,
}

impl HardwareProfile {
    /// Quelques appels système rapides (pas de processus lancé).
    pub fn detect() -> Self {
        let logical_cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let physical_cores = platform::physical_cores().unwrap_or((logical_cores / 2).max(1));
        let profile = Self {
            gpus: platform::gpus(),
            total_memory_bytes: platform::total_memory().unwrap_or(0),
            physical_cores,
            logical_cores,
            avx2: has_avx2(),
        };
        log::info!("[Hardware] {profile:?}");
        profile
    }

    /// Carte NVIDIA qui a le plus de mémoire : seule cible du build CUDA de whisper.cpp.
    pub fn cuda_gpu(&self) -> Option<&GpuInfo> {
        self.gpus
            .iter()
            .filter(|gpu| gpu.vendor == GpuVendor::Nvidia)
            .max_by_key(|gpu| gpu.memory_bytes)
    }

    /// Carte NVIDIA si le modèle y tient, sinon processeur et mémoire vive.
    pub fn place(&self, model_memory_bytes: u64) -> Placement {
        if let Some(gpu) = self.cuda_gpu() {
            if model_memory_bytes <= gpu.memory_bytes.saturating_sub(GPU_RESERVED_BYTES) {
                return Placement {
                    device: Device::Gpu,
                    fit: Fit::Ok,
                };
            }
        }
        // Processeur : on laisse au moins la moitié de la mémoire vive au reste du PC.
        let total = self.total_memory_bytes;
        let fit = if total == 0 || model_memory_bytes <= total / 2 {
            Fit::Ok // mémoire inconnue : on ne bloque pas
        } else if model_memory_bytes <= total / 4 * 3 {
            Fit::Tight
        } else {
            Fit::TooBig
        };
        Placement {
            device: Device::Cpu,
            fit,
        }
    }
}

fn has_avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

#[cfg(windows)]
mod platform {
    use super::{GpuInfo, GpuVendor};
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::SystemInformation::{
        GetLogicalProcessorInformation, GlobalMemoryStatusEx, RelationProcessorCore, MEMORYSTATUSEX,
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION,
    };

    /// Cartes graphiques vues par DXGI, toutes marques. Contrairement à WMI
    /// (`Win32_VideoController.AdapterRAM`, plafonné à 4 Go), la mémoire est exacte.
    pub fn gpus() -> Vec<GpuInfo> {
        let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
            return Vec::new();
        };
        let mut gpus = Vec::new();
        // EnumAdapters1 échoue (DXGI_ERROR_NOT_FOUND) après le dernier adaptateur.
        for index in 0u32.. {
            let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else { break };
            let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
            // Pilote d'affichage de base Microsoft (rendu logiciel) : pas une vraie carte.
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            gpus.push(GpuInfo {
                name: String::from_utf16_lossy(&desc.Description[..len]).trim().to_string(),
                vendor: GpuVendor::from_pci_id(desc.VendorId),
                memory_bytes: desc.DedicatedVideoMemory as u64,
            });
        }
        gpus
    }

    pub fn total_memory() -> Option<u64> {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
        Some(status.ullTotalPhys)
    }

    /// Cœurs physiques (un processeur hybride compte ses cœurs P et E).
    pub fn physical_cores() -> Option<usize> {
        let item = std::mem::size_of::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION>();
        let mut len = 0u32;
        // Premier appel : il échoue en donnant la taille nécessaire.
        let _ = unsafe { GetLogicalProcessorInformation(None, &mut len) };
        let count = len as usize / item;
        if count == 0 {
            return None;
        }
        let mut infos = vec![SYSTEM_LOGICAL_PROCESSOR_INFORMATION::default(); count];
        unsafe { GetLogicalProcessorInformation(Some(infos.as_mut_ptr()), &mut len) }.ok()?;
        let cores = infos
            .iter()
            .take(len as usize / item)
            .filter(|info| info.Relationship == RelationProcessorCore)
            .count();
        (cores > 0).then_some(cores)
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn gpus() -> Vec<super::GpuInfo> {
        Vec::new()
    }

    pub fn total_memory() -> Option<u64> {
        None
    }

    pub fn physical_cores() -> Option<usize> {
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    /// Profil de test : une carte NVIDIA (`vram` octets, aucune si 0), `ram` octets de mémoire vive.
    pub(crate) fn profile(vram: u64, ram: u64, cores: usize) -> HardwareProfile {
        let mut gpus = vec![GpuInfo {
            name: "Intel(R) UHD Graphics".to_string(),
            vendor: GpuVendor::Intel,
            memory_bytes: 128 * MB,
        }];
        if vram > 0 {
            gpus.push(GpuInfo {
                name: "NVIDIA GeForce RTX".to_string(),
                vendor: GpuVendor::Nvidia,
                memory_bytes: vram,
            });
        }
        HardwareProfile {
            gpus,
            total_memory_bytes: ram,
            physical_cores: cores,
            logical_cores: cores * 2,
            avx2: true,
        }
    }

    #[test]
    fn vendor_comes_from_the_pci_id() {
        assert_eq!(GpuVendor::from_pci_id(0x10DE), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_pci_id(0x1002), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_pci_id(0x8086), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_pci_id(0x1414), GpuVendor::Other);
    }

    #[test]
    fn cuda_gpu_ignores_other_vendors_and_keeps_the_largest() {
        let mut hw = profile(4 * GB, 32 * GB, 8);
        assert_eq!(hw.cuda_gpu().unwrap().memory_bytes, 4 * GB);
        hw.gpus.push(GpuInfo {
            name: "NVIDIA eGPU".to_string(),
            vendor: GpuVendor::Nvidia,
            memory_bytes: 12 * GB,
        });
        assert_eq!(hw.cuda_gpu().unwrap().name, "NVIDIA eGPU");
        assert!(profile(0, 32 * GB, 8).cuda_gpu().is_none(), "l'iGPU Intel n'est pas une cible CUDA");
    }

    #[test]
    fn a_model_goes_on_the_gpu_when_it_fits_beside_the_reserve() {
        let hw = profile(4 * GB, 32 * GB, 8);
        assert_eq!(hw.place(1_600 * MB).device, Device::Gpu);
        assert_eq!(hw.place(4 * GB - GPU_RESERVED_BYTES).device, Device::Gpu);
        // Trop gros pour la carte : processeur, où 32 Go suffisent.
        let placement = hw.place(3_600 * MB);
        assert_eq!(placement, Placement { device: Device::Cpu, fit: Fit::Ok });
    }

    #[test]
    fn without_nvidia_the_fit_depends_on_the_ram() {
        let hw = profile(0, 16 * GB, 8);
        assert_eq!(hw.place(2 * GB), Placement { device: Device::Cpu, fit: Fit::Ok });
        assert_eq!(hw.place(10 * GB).fit, Fit::Tight);
        assert_eq!(hw.place(13 * GB).fit, Fit::TooBig);
    }

    #[test]
    fn unknown_ram_never_blocks_a_model() {
        assert_eq!(profile(0, 0, 4).place(3 * GB).fit, Fit::Ok);
    }

    #[test]
    fn detection_returns_a_usable_profile() {
        let hw = HardwareProfile::detect();
        println!("{hw:#?}"); // visible avec `cargo test detection -- --nocapture`
        assert!(hw.logical_cores >= 1);
        assert!(hw.physical_cores >= 1 && hw.physical_cores <= hw.logical_cores);
        #[cfg(windows)]
        assert!(hw.total_memory_bytes > 0);
    }

    #[test]
    fn profile_is_serialized_in_camel_case() {
        let json = serde_json::to_value(profile(4 * GB, 32 * GB, 8)).unwrap();
        assert_eq!(json["gpus"][1]["vendor"], "nvidia");
        assert!(json["gpus"][1]["memoryBytes"].is_number());
        assert!(json["totalMemoryBytes"].is_number());
        assert_eq!(serde_json::to_value(Fit::TooBig).unwrap(), "tooBig");
        assert_eq!(serde_json::to_value(Device::Gpu).unwrap(), "gpu");
    }
}
