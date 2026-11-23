"""Ideal-gas thermochemistry: RRHO and Grimme's quasi-RRHO entropy (Chem. Eur. J. 18, 9955, 2012)."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from rdkit import Chem

H = 6.62607015e-34
KB = 1.380649e-23
C_CM = 2.99792458e10
NA = 6.02214076e23
R = 8.314462618
AMU = 1.66053906660e-27
HARTREE_J_MOL = 2625499.6394799
QRRHO_CUTOFF = 100.0  # cm-1
B_AV = 1.0e-44  # kg m^2


def symmetry_number(mol: Chem.Mol, tol: float = 0.15) -> int:
    """Rotational symmetry number = number of proper rotations mapping the 3D structure onto itself.

    Candidate operations come from graph automorphisms; each is accepted when a proper rotation
    (det = +1, Kabsch) superimposes the permuted coordinates within ``tol`` Å RMSD.
    """
    pos = mol.GetConformer().GetPositions()
    centred = pos - pos.mean(axis=0)
    matches = mol.GetSubstructMatches(mol, uniquify=False, useChirality=False, maxMatches=5000)
    count = 0
    for perm in matches:
        target = centred[list(perm)]
        h = centred.T @ target
        u, _s, vt = np.linalg.svd(h)
        d = 1.0 if np.linalg.det(vt.T @ u.T) >= 0 else -1.0
        # Best *proper* rotation (Kabsch with reflection correction); for planar molecules the
        # SVD may return a reflection that is equivalent to a proper rotation.
        rot = vt.T @ np.diag([1.0, 1.0, d]) @ u.T
        rmsd = math.sqrt(float((((rot @ centred.T).T - target) ** 2).sum()) / len(pos))
        if rmsd < tol:
            count += 1
    return max(1, count)


def principal_moments(mol: Chem.Mol) -> tuple[np.ndarray, bool]:
    pos = mol.GetConformer().GetPositions() * 1e-10
    masses = np.array([a.GetMass() for a in mol.GetAtoms()]) * AMU
    com = (pos * masses[:, None]).sum(axis=0) / masses.sum()
    r = pos - com
    inertia = np.zeros((3, 3))
    for m, v in zip(masses, r, strict=True):
        inertia += m * (np.dot(v, v) * np.eye(3) - np.outer(v, v))
    moments = np.sort(np.linalg.eigvalsh(inertia))
    linear = mol.GetNumAtoms() == 2 or (moments[0] < 1e-3 * moments[2] and mol.GetNumAtoms() > 1)
    return moments, linear


def rotational_constants(mol: Chem.Mol) -> dict[str, Any]:
    moments, linear = principal_moments(mol)
    ghz = [H / (8 * math.pi**2 * m) / 1e9 if m > 1e-50 else None for m in moments]
    cm = [H / (8 * math.pi**2 * C_CM * m) if m > 1e-50 else None for m in moments]
    amu_a2 = [m / AMU * 1e20 for m in moments]
    return {"momentsAmuA2": amu_a2, "ghz": ghz, "cm": cm, "linear": linear}


def _vib_terms(freqs_cm: list[float], temperature: float) -> dict[str, float]:
    zpe = e_th = s = s_q = cv = 0.0
    for nu in freqs_cm:
        if nu <= 0:
            continue
        theta = H * C_CM * nu / KB
        x = theta / temperature
        zpe += 0.5 * R * theta
        ex = math.exp(min(x, 700))
        e_th += R * theta * (0.5 + 1.0 / (ex - 1.0))
        s_v = R * (x / (ex - 1.0) - math.log(1.0 - math.exp(-x)))
        cv += R * x * x * ex / (ex - 1.0) ** 2
        # Grimme free-rotor interpolation for low-frequency modes
        omega = C_CM * nu
        mu = H / (8 * math.pi**2 * omega)
        mu_eff = mu * B_AV / (mu + B_AV)
        s_r = R * (0.5 + math.log(math.sqrt(8 * math.pi**3 * mu_eff * KB * temperature / H**2)))
        w = 1.0 / (1.0 + (QRRHO_CUTOFF / nu) ** 4)
        s += s_v
        s_q += w * s_v + (1 - w) * s_r
    return {"zpe": zpe, "e": e_th, "s": s, "sq": s_q, "cv": cv}


def thermochemistry(mol: Chem.Mol, freqs_cm: list[float], electronic_energy_hartree: float | None, *,
                    temperature: float = 298.15, pressure: float = 101325.0, multiplicity: int = 1,
                    method: str = "GFN2-xTB") -> dict[str, Any]:
    real = [f for f in freqs_cm if f > 1.0]
    imaginary = [f for f in freqs_cm if f < -1.0]
    mass = sum(a.GetMass() for a in mol.GetAtoms()) * AMU
    q_t = (2 * math.pi * mass * KB * temperature / H**2) ** 1.5 * KB * temperature / pressure
    s_t = R * (math.log(q_t) + 2.5)
    e_t = 1.5 * R * temperature
    sigma = symmetry_number(mol)
    moments, linear = principal_moments(mol)
    if mol.GetNumAtoms() == 1:
        s_r = e_r = 0.0
        cv_r = 0.0
    elif linear:
        theta = H**2 / (8 * math.pi**2 * moments[2] * KB)
        s_r = R * (math.log(temperature / (sigma * theta)) + 1.0)
        e_r = R * temperature
        cv_r = R
    else:
        thetas = [H**2 / (8 * math.pi**2 * m * KB) for m in moments]
        q_r = math.sqrt(math.pi) / sigma * math.sqrt(temperature**3 / (thetas[0] * thetas[1] * thetas[2]))
        s_r = R * (math.log(q_r) + 1.5)
        e_r = 1.5 * R * temperature
        cv_r = 1.5 * R
    s_e = R * math.log(max(1, multiplicity))
    vib = _vib_terms(real, temperature)
    h_corr = e_t + e_r + vib["e"] + R * temperature  # J/mol, includes ZPE
    s_tot = s_t + s_r + vib["s"] + s_e
    s_tot_q = s_t + s_r + vib["sq"] + s_e
    g_corr = h_corr - temperature * s_tot
    g_corr_q = h_corr - temperature * s_tot_q
    kj = 1 / 1000.0
    out: dict[str, Any] = {
        "temperatureK": temperature,
        "pressurePa": pressure,
        "symmetryNumber": sigma,
        "linear": bool(linear),
        "imaginaryFrequencies": imaginary,
        "zeroPointEnergy": {"value": round(vib["zpe"] * kj, 4), "unit": "kJ/mol"},
        "thermalEnthalpyCorrection": {"value": round(h_corr * kj, 4), "unit": "kJ/mol"},
        "entropy": {"value": round(s_tot, 3), "unit": "J/(mol·K)",
                    "components": {"translational": round(s_t, 3), "rotational": round(s_r, 3),
                                   "vibrational": round(vib["s"], 3), "electronic": round(s_e, 3)}},
        "entropyQuasiRRHO": {"value": round(s_tot_q, 3), "unit": "J/(mol·K)", "cutoffCm": QRRHO_CUTOFF,
                             "components": {"vibrational": round(vib["sq"], 3)}},
        "heatCapacityCv": {"value": round(1.5 * R + cv_r + vib["cv"], 3), "unit": "J/(mol·K)"},
        "heatCapacityCp": {"value": round(2.5 * R + cv_r + vib["cv"], 3), "unit": "J/(mol·K)"},
        "gibbsCorrection": {"value": round(g_corr * kj, 4), "unit": "kJ/mol"},
        "gibbsCorrectionQuasiRRHO": {"value": round(g_corr_q * kj, 4), "unit": "kJ/mol"},
        "method": f"Ideal gas / rigid rotor / harmonic oscillator on {method} frequencies; quasi-RRHO per Grimme 2012",
    }
    if electronic_energy_hartree is not None:
        e_j = electronic_energy_hartree * HARTREE_J_MOL
        out["enthalpy"] = {"value": round((e_j + h_corr) / HARTREE_J_MOL, 8), "unit": "Eh"}
        out["gibbsFreeEnergy"] = {"value": round((e_j + g_corr_q) / HARTREE_J_MOL, 8), "unit": "Eh"}
    return out
