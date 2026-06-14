# 2D Fourier Transform Image Signal Mixer & Frequency Domain Studio

A production-grade, asynchronous multi-processor 2D signal processing application engineered to modulate and mix the discrete frequency domain components of multiple spatial signals (images). By splitting a highly responsive **Vite / React (TypeScript)** presentation dashboard from a mathematical **FastAPI (Python)** server, this studio visualizes the relative structural and geometric significance of Magnitude, Phase, Real, and Imaginary components through weighted averaging, localized spectrum region clipping, and multi-threaded inverse transformations.

---

## Technical Pipeline Architecture

The processing backplane enforces strict lifecycle execution parameters. If a client triggers a new frequency mixing state before a legacy calculation completes, the active execution thread is immediately terminated to preserve CPU boundaries.

```text
+---------------------------------------------------------------------------------------+
|                              VITE / REACT GRAPHICAL SUITE                             |
|    (4 Input Nodes, 2 Assignable Output Ports, Canvas Trackers, Mouse Contrast Maps)    |
+---------------------------------------------------------------------------------------+
                                           |
                           JSON State + Active Matrix Buffers
                                           v
+---------------------------------------------------------------------------------------+
|                              FASTAPI ROUTING & LIFECYCLE                              |
|       (Thread Supervisor, Active Job Drop Middleware, Request Demuxing Kernels)       |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
|                                COMPUTATIONAL SIGNAL BACKPLANE                         |
|   +---------------------------------------+   +-----------------------------------+   |
|   |         IMAGE STRUCTURAL UNIT         |   |          2D FOURIER ENGINE        |   |
|   | - Grayscale Desaturation Filters      |   | - 2D Discrete Fourier Kernel      |   |
|   | - Uniform Boundary Resizing Matcher   |   | - Regional Rectangular Masker     |   |
|   | - Real-time Mouse Contrast Shifters   |   | - Overlap-Add Multi-Source Mixer  |   |
|   +---------------------------------------+   +-----------------------------------+   |
+---------------------------------------------------------------------------------------+

```

---

## Core System Specifications

### 1. Unified Quad-Viewport Presentation Cluster

* **Automatic Grayscale Conversion:** Upon uploading any colored target, the MCAL pipelines desaturate multi-channel image layouts into standardized 8-bit single-channel arrays instantly.
* **Smallest-Bound Size Unification Constraint:** To protect linear array dot-products during matrix mathematical operations, the system dynamically scans all four active viewports. It scales down all loaded images uniformly to match the absolute smallest dimensions among them:

$$\text{Target Size} = (\min(W_1, W_2, W_3, W_4), \min(H_1, H_2, H_3, H_4))$$


* **Component Selector:** Each image node retains an independent dropdown menu to switch viewports natively between:
1. **Fourier Transform Magnitude:** Displays the power spectrum distribution.
2. **Fourier Transform Phase:** Exposes the structural spatial coordinates.
3. **Fourier Transform Real:** Reveals symmetric array components.
4. **Fourier Transform Imaginary:** Reveals asymmetric spatial behaviors.


* **Double-Click Browse Bindings:** Eliminates standard file selection buttons; double-clicking directly on any designated canvas viewport triggers localized image asset browsing.

### 2. Multi-Channel Component Mixer

* **Cross-Component Sliders:** Provides users with interactive, coupled controls to configure weight coefficients $W_i$ ranging from $0\%$ to $100\%$.
* **Mathematical Re-Synthesis Dual Output Ports:** Synthesizes weighted operations onto one of two dedicated output ports selected via user preference. The synthesis logic computes the 2D Inverse Fourier Transform over the accumulated matrix mix:

$$X_{\text{mixed}}[u,v] = \sum_{i=1}^{4} \left( W_{i,\text{mag}} \cdot |X_i[u,v]| \cdot e^{j \angle X_i[u,v]} \right)$$



### 3. Unified Geometric Regions Mixer (Low/High Pass Filtering)

* **Interactive Frequency Range Selection:** Users draw a bounding rectangular frame over any frequency display node to isolate specific bands.
* **Inner vs. Outer Spectral Masks:**
* **Inner Region (Low Frequencies):** Preserves general illumination maps and structural shapes while stripping sharp transitions (Blurs image layout edges).
* **Outer Region (High Frequencies):** Retains sharp transitions and physical board outlines while scrubbing out localized DC lighting balances (Isolates spatial edges).


* **Global Boundary Synchronization:** Adjusting the selection box dimensions or scales on one display updates the masking matrices across all four input channels concurrently to ensure operational data harmony.

### 4. Interactive Window/Level Contrast Adjusters

* Captures high-frequency mouse dragging vectors inside any component viewer viewport.
* **Horizontal Displacement ($\Delta X$):** Modulates the data range window width (Contrast adjustments).
* **Vertical Displacement ($\Delta Y$):** Shifts the global center level point (Brightness adjustments).

### 5. Multi-Threaded Real-Time Concurrency Protection

* **Asynchronous Progress Trackers:** Integrates a responsive UI progress bar indicating computational completion parameters for heavy Inverse 2D-FFT procedures.
* **Race-Condition Thread Execution Guards:** Implements strict debounce and task cancellation protocols within the API routers. If a client triggers slider adjustments while a prior IFFT task is occupying execution stacks, the background process is immediately signaled for atomic termination, resetting the processing pipe for the incoming state request.

---

## Architectural Repository Schema

The repository maintains an explicit structural decoupling between the heavy mathematical algorithms and user-interface state hooks:

```text
Fourier-Image-Signal-Mixer-Studio/
├── backend/
│   ├── .venv/                      # Isolated python virtual environment
│   └── app/
│       ├── main.py                 # FastAPI initialization, routing, and thread cancellation handlers
│       ├── fourier_core.py         # Advanced 2D Fourier transformations and component extraction
│       ├── mixer_engine.py         # Multi-source weighted matrix integration and region masking
│       └── utils.py                # Grayscale conversion and image dimension unification filters
└── frontend/
    ├── src/                        # Complete React TypeScript source code tree
    │   ├── assets/                 # Vector layouts, standard testing textures, and styling parameters
    │   └── App.tsx                 # Core centralized graphical client state manager
    ├── public/                     # Static file system testing objects and page icons
    ├── tailwind.config.cjs         # Tailwind utility styling specifications
    ├── vite.config.js              # Vite packaging compilation optimization parameters
    ├── package.json                # Front-end environment dependencies manifest
    └── tsconfig.json               # TypeScript strict evaluation compilation configuration

```

---

## Setup and Development Guide

### 1. Booting the Python Mathematical Backend

Ensure your system paths have pre-configured `python3` setups before launching the computational server:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install fastapi uvicorn numpy opencv-python
uvicorn app.main:app --reload --port 8000

```

### 2. Launching the Front-End Presentation Layer

```bash
cd ../frontend
npm install
npm run dev

```

Navigate to the web interface via the browser URL presented in your terminal output (Default: [http://localhost:5173](http://localhost:5173)).
