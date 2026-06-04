// ── CAD OVERLAY APP — WebXR Edition (Fixed) ──
// Fix: canvas null error — step switches first, then useEffect inits Three.js+WebXR

import { useState, useRef, useEffect, useCallback } from "react";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function Toast({ message, type = "info", onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, []);
  const colors = {
    success: { bg: "#00ff88", tx: "#000" },
    warn:    { bg: "#ffcc00", tx: "#000" },
    error:   { bg: "#ff4444", tx: "#fff" },
    info:    { bg: "#0088ff", tx: "#fff" },
  };
  const c = colors[type] || colors.info;
  return (
    <div style={{
      position:"fixed", top:90, left:"50%", transform:"translateX(-50%)",
      background:c.bg, color:c.tx, padding:"10px 22px", borderRadius:10,
      fontFamily:"'JetBrains Mono',monospace", fontWeight:700, fontSize:12,
      zIndex:9999, letterSpacing:0.5, whiteSpace:"nowrap",
      animation:"toastIn 0.3s cubic-bezier(0.34,1.56,0.64,1)",
      boxShadow:`0 4px 24px ${c.bg}66`
    }}>{message}</div>
  );
}

function ScanRing() {
  return (
    <div style={{ position:"relative", width:180, height:180, margin:"0 auto 24px" }}>
      {[0,1,2].map(i => (
        <div key={i} style={{
          position:"absolute", inset:0, borderRadius:"50%",
          border:"1px solid #00ff88",
          animation:`scanRing 2s ease-out ${i*0.6}s infinite`,
          opacity:0
        }} />
      ))}
      <div style={{
        position:"absolute", inset:"30%", borderRadius:"50%",
        background:"rgba(0,255,136,0.08)", border:"1px solid #00ff8844",
        display:"flex", alignItems:"center", justifyContent:"center"
      }}>
        <div style={{ fontSize:32 }}>⬡</div>
      </div>
    </div>
  );
}

export default function CADOverlayApp() {

  // ── STATE ──
  const [step, setStep]               = useState("upload"); // upload | ar
  const [threeReady, setThreeReady]   = useState(false);
  const [xrSupported, setXrSupported] = useState(null);
  const [parseInfo, setParseInfo]     = useState(null);
  const [parseError, setParseError]   = useState(null);
  const [arError, setArError]         = useState(null);
  const [toast, setToast]             = useState(null);
  const [transform, setTransform]     = useState({ scale:1, rotY:0 });
  const [isPlaced, setIsPlaced]       = useState(false);
  const [hitAvailable, setHitAvailable] = useState(false);
  const [scanning, setScanning]       = useState(true);
  const [fov, setFov]                 = useState(70);
  const [showFovTuner, setShowFovTuner] = useState(false);
  const [initStatus, setInitStatus]   = useState(""); // for loading feedback

  // ── REFS ──
  const canvasRef          = useRef(null);
  const geometryRef        = useRef(null);
  const previewCanvasRef   = useRef(null);
  const previewAnimRef     = useRef(null);
  const rendererPreviewRef = useRef(null);
  const rendererRef        = useRef(null);
  const sceneRef           = useRef(null);
  const cameraRef          = useRef(null);
  const meshRef            = useRef(null);
  const reticleMeshRef     = useRef(null);
  const xrSessionRef       = useRef(null);
  const xrRefSpaceRef      = useRef(null);
  const hitTestSrcRef      = useRef(null);
  const transformRef       = useRef({ scale:1, rotY:0 });
  const placedRef          = useRef(false);
  const lastTouchRef       = useRef(null);
  const lastPinchRef       = useRef(null);
  const lastAngleRef       = useRef(null);
  const gestureLayerRef    = useRef(null);
  const arErrorRef         = useRef(null); // to set error from inside async

  // ── LOAD SCRIPTS ──
  useEffect(() => {
    async function load() {
      try {
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js");
        await loadScript("https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js");
        setThreeReady(true);
      } catch(e) { console.error("Three.js failed", e); }

      if (navigator.xr) {
        try {
          const supported = await navigator.xr.isSessionSupported("immersive-ar");
          setXrSupported(supported);
        } catch { setXrSupported(false); }
      } else {
        setXrSupported(false);
      }
    }
    load();
    return () => {
      cleanupAR();
      cancelAnimationFrame(previewAnimRef.current);
      rendererPreviewRef.current?.dispose();
    };
  }, []);

  // ── KEY FIX: useEffect watches step — fires AFTER canvas is in the DOM ──
  useEffect(() => {
    if (step !== "ar") return;
    // Small delay to guarantee React has painted the canvas to DOM
    const timer = setTimeout(() => {
      initARSession();
    }, 80);
    return () => {
      clearTimeout(timer);
      cleanupAR();
    };
  }, [step]);

  // ── STL PARSE ──
  const handleFile = useCallback((file) => {
    if (!file || !file.name.toLowerCase().endsWith(".stl")) {
      setParseError("Only .stl files accepted."); return;
    }
    if (!threeReady) { setParseError("3D engine still loading, please wait."); return; }
    setParseError(null); setParseInfo(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const THREE = window.THREE;
        const geo = new THREE.STLLoader().parse(e.target.result);
        geo.computeBoundingBox(); geo.center();
        const bb = geo.boundingBox;
        const w = (bb.max.x - bb.min.x).toFixed(1);
        const h = (bb.max.y - bb.min.y).toFixed(1);
        const d = (bb.max.z - bb.min.z).toFixed(1);
        const tris = Math.round(geo.attributes.position.count / 3);
        geometryRef.current = geo;
        setParseInfo({ name: file.name, tris, w, h, d });
        setTimeout(() => initPreview(geo), 50);
      } catch { setParseError("Invalid STL. Try another file."); }
    };
    reader.readAsArrayBuffer(file);
  }, [threeReady]);

  function initPreview(geo) {
    const canvas = previewCanvasRef.current; if (!canvas) return;
    const THREE = window.THREE;
    if (rendererPreviewRef.current) {
      rendererPreviewRef.current.dispose();
      cancelAnimationFrame(previewAnimRef.current);
    }
    const renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true });
    renderer.setSize(280, 280); renderer.setClearColor(0, 0);
    rendererPreviewRef.current = renderer;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    const sphere = new THREE.Sphere();
    new THREE.Box3().setFromObject(new THREE.Mesh(geo)).getBoundingSphere(sphere);
    cam.position.set(0, 0, sphere.radius * 2.8);
    const mesh = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x00ff88 })
    );
    scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff, 1));
    const loop = () => {
      previewAnimRef.current = requestAnimationFrame(loop);
      mesh.rotation.y += 0.012;
      mesh.rotation.x = Math.sin(Date.now() * 0.0005) * 0.3;
      renderer.render(scene, cam);
    };
    loop();
  }

  // ── STEP 1: startAR — just validates + switches screen ──
  // Canvas does NOT exist yet here, so we do nothing with Three.js
  async function startAR() {
    setArError(null);
    setInitStatus("Checking AR support...");

    if (!navigator.xr) {
      setArError("WebXR not available. Use Chrome on Android or Safari on iOS 16+.");
      setInitStatus("");
      return;
    }
    try {
      const supported = await navigator.xr.isSessionSupported("immersive-ar");
      if (!supported) {
        setArError("AR (immersive-ar) not supported on this device or browser.");
        setInitStatus("");
        return;
      }
    } catch(e) {
      setArError("Could not check AR support: " + e.message);
      setInitStatus("");
      return;
    }

    // All good — switch to AR screen
    // The useEffect watching step="ar" will call initARSession()
    // AFTER React has rendered the canvas into the DOM
    setInitStatus("Launching AR...");
    setStep("ar");
  }

  // ── STEP 2: initARSession — called from useEffect, canvas guaranteed to exist ──
  async function initARSession() {
    const THREE = window.THREE;

    // Safety check — should never be null here, but just in case
    const canvas = canvasRef.current;
    if (!canvas) {
      setArError("Canvas failed to mount. Please reload the page and try again.");
      setStep("upload");
      return;
    }

    setInitStatus("Initialising renderer...");

    try {
      // ── Three.js Renderer ──
      if (rendererRef.current) {
        rendererRef.current.setAnimationLoop(null);
        rendererRef.current.dispose();
        rendererRef.current = null;
      }

      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance"
      });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.xr.enabled = true;
      renderer.setClearColor(0x000000, 0);
      rendererRef.current = renderer;

      // ── Scene ──
      const scene = new THREE.Scene();
      sceneRef.current = scene;
      scene.add(new THREE.AmbientLight(0xffffff, 0.8));
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
      dirLight.position.set(1, 2, 3);
      scene.add(dirLight);

      // ── Camera ──
      const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
      cameraRef.current = camera;

      // ── STL Wireframe Mesh ──
      const geo = geometryRef.current;
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const maxDim = Math.max(bb.max.x-bb.min.x, bb.max.y-bb.min.y, bb.max.z-bb.min.z);
      const worldScale = 0.3 / maxDim; // ~30cm in real world

      const mesh = new THREE.LineSegments(
        new THREE.WireframeGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 1.5 })
      );
      mesh.scale.setScalar(worldScale);
      mesh.visible = false;
      scene.add(mesh);
      meshRef.current = mesh;
      mesh.add(new THREE.AxesHelper(0.15));

      // ── Reticle (hit-test target ring) ──
      const reticleGeo = new THREE.RingGeometry(0.08, 0.12, 32);
      reticleGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      const reticle = new THREE.Mesh(
        reticleGeo,
        new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide })
      );
      reticle.visible = false;
      scene.add(reticle);
      reticleMeshRef.current = reticle;

      setInitStatus("Requesting AR session...");

      // ── WebXR Session ──
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["dom-overlay", "anchors"],
        domOverlay: { root: document.getElementById("ar-overlay") }
      });
      xrSessionRef.current = session;

      setInitStatus("Setting up tracking...");

      renderer.xr.setReferenceSpaceType("local");
      await renderer.xr.setSession(session);

      // ── Reference Spaces ──
      const refSpace = await session.requestReferenceSpace("local");
      xrRefSpaceRef.current = refSpace;

      const viewerSpace = await session.requestReferenceSpace("viewer");
      const hitTestSrc = await session.requestHitTestSource({ space: viewerSpace });
      hitTestSrcRef.current = hitTestSrc;

      // ── Reset transform state ──
      transformRef.current = { scale: worldScale, rotY: 0 };
      setTransform({ scale: worldScale, rotY: 0 });
      placedRef.current = false;
      setIsPlaced(false);
      setScanning(true);
      setHitAvailable(false);
      setInitStatus("");

      // ── XR Render Loop ──
      renderer.setAnimationLoop((timestamp, frame) => {
        if (!frame) return;

        const rSpace = xrRefSpaceRef.current;
        const hSrc = hitTestSrcRef.current;

        // Hit test → move reticle
        if (hSrc && !placedRef.current) {
          const hits = frame.getHitTestResults(hSrc);
          if (hits.length > 0) {
            const hitPose = hits[0].getPose(rSpace);
            if (hitPose) {
              reticle.visible = true;
              reticle.matrix.fromArray(hitPose.transform.matrix);
              reticle.matrixAutoUpdate = false;
              setHitAvailable(true);
              setScanning(false);
            }
          } else {
            reticle.visible = false;
            setHitAvailable(false);
          }
        }

        // Apply real camera pose from ARCore/ARKit
        const viewerPose = frame.getViewerPose(rSpace);
        if (viewerPose) {
          const view = viewerPose.views[0];
          // Use the REAL lens projection matrix from the device
          camera.projectionMatrix.fromArray(view.projectionMatrix);
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
          // Use the REAL camera world transform
          camera.matrix.fromArray(view.transform.matrix);
          camera.matrixWorldNeedsUpdate = true;
        }

        renderer.render(scene, camera);
      });

      // Handle session end (user pressed back / home)
      session.addEventListener("end", () => {
        cleanupAR();
        setStep("upload");
        setToast({ message: "AR session ended", type: "info" });
      });

    } catch(err) {
      console.error("WebXR initARSession error:", err);
      const msg =
        err.name === "NotSupportedError"  ? "AR not supported on this device." :
        err.name === "SecurityError"      ? "HTTPS required. Make sure you're on https://realtracking.netlify.app" :
        err.name === "NotAllowedError"    ? "Camera permission denied. Tap Allow when prompted." :
        err.name === "InvalidStateError"  ? "AR session conflict. Please reload the page." :
        err.name === "AbortError"         ? "AR session was cancelled. Try again." :
        "AR failed: " + err.message;

      setArError(msg);
      setInitStatus("");
      cleanupAR();
      setStep("upload");
    }
  }

  // ── PLACE MODEL at reticle position ──
  function placeModel() {
    const reticle = reticleMeshRef.current;
    const mesh = meshRef.current;
    if (!reticle || !reticle.visible || !mesh) return;

    const THREE = window.THREE;
    const pos  = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl  = new THREE.Vector3();
    reticle.matrix.decompose(pos, quat, scl);

    mesh.position.copy(pos);
    mesh.quaternion.copy(quat);
    mesh.scale.setScalar(transformRef.current.scale);
    mesh.rotation.y += transformRef.current.rotY;
    mesh.visible = true;

    reticle.visible = false;
    placedRef.current = true;
    setIsPlaced(true);
    setHitAvailable(false);
    setToast({ message: "✅ Model placed! Drag to rotate, pinch to scale.", type: "success" });
  }

  // ── REPOSITION — unplace and scan again ──
  function repositionModel() {
    const mesh    = meshRef.current;
    const reticle = reticleMeshRef.current;
    if (mesh)    mesh.visible    = false;
    if (reticle) reticle.visible = false;
    placedRef.current = false;
    setIsPlaced(false);
    setScanning(true);
    setHitAvailable(false);
    setToast({ message: "Move camera over a flat surface", type: "info" });
  }

  // ── GESTURES (drag = rotate Y, pinch = scale) ──
  useEffect(() => {
    if (step !== "ar") return;
    const el = gestureLayerRef.current; if (!el) return;

    const onTS = (e) => {
      if (e.touches.length === 1) {
        lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        lastPinchRef.current = Math.hypot(dx, dy);
        lastAngleRef.current = Math.atan2(dy, dx);
      }
    };

    const onTM = (e) => {
      e.preventDefault();
      const mesh = meshRef.current;
      if (!mesh || !placedRef.current) return;

      if (e.touches.length === 1 && lastTouchRef.current) {
        const dx = e.touches[0].clientX - lastTouchRef.current.x;
        mesh.rotation.y += dx * 0.01;
        transformRef.current.rotY = mesh.rotation.y;
        lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        setTransform(t => ({ ...t, rotY: mesh.rotation.y }));

      } else if (e.touches.length === 2) {
        const dx   = e.touches[1].clientX - e.touches[0].clientX;
        const dy   = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.hypot(dx, dy);

        if (lastPinchRef.current) {
          const ratio = dist / lastPinchRef.current;
          const ns    = transformRef.current.scale * ratio;
          if (ns > 0.001 && ns < 10) {
            mesh.scale.setScalar(ns);
            transformRef.current.scale = ns;
            setTransform(t => ({ ...t, scale: ns }));
          }
        }
        lastPinchRef.current = dist;
        lastAngleRef.current = Math.atan2(dy, dx);
      }
    };

    const onTE = () => {
      lastTouchRef.current  = null;
      lastPinchRef.current  = null;
      lastAngleRef.current  = null;
    };

    el.addEventListener("touchstart", onTS, { passive: false });
    el.addEventListener("touchmove",  onTM, { passive: false });
    el.addEventListener("touchend",   onTE);
    return () => {
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchmove",  onTM);
      el.removeEventListener("touchend",   onTE);
    };
  }, [step]);

  // ── CLEANUP ──
  function cleanupAR() {
    if (rendererRef.current) {
      rendererRef.current.setAnimationLoop(null);
      rendererRef.current.dispose();
      rendererRef.current = null;
    }
    if (hitTestSrcRef.current) {
      try { hitTestSrcRef.current.cancel(); } catch {}
      hitTestSrcRef.current = null;
    }
    if (xrSessionRef.current) {
      try { xrSessionRef.current.end(); } catch {}
      xrSessionRef.current = null;
    }
    xrRefSpaceRef.current = null;
    meshRef.current       = null;
    reticleMeshRef.current = null;
    sceneRef.current      = null;
    cameraRef.current     = null;
  }

  const onDrop = (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); };

  // ════════════════════════════════════════════
  // ── RENDER: UPLOAD SCREEN ──
  // ════════════════════════════════════════════
  if (step === "upload") return (
    <div style={{
      minHeight:"100vh", background:"#080c08",
      display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center",
      padding:"24px 16px",
      fontFamily:"'JetBrains Mono','Courier New',monospace"
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&display=swap');
        @keyframes toastIn  { from{opacity:0;transform:translate(-50%,-12px) scale(0.9)} to{opacity:1;transform:translate(-50%,0) scale(1)} }
        @keyframes scanRing { 0%{transform:scale(0.4);opacity:0.8} 100%{transform:scale(2);opacity:0} }
        @keyframes spin     { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        @keyframes fadeUp   { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes gridPulse{ 0%,100%{opacity:0.03} 50%{opacity:0.07} }
        .dz:hover  { border-color:#00ff88!important; background:rgba(0,255,136,0.04)!important; }
        .dz:hover .dz-icon { color:#00ff88!important; transform:scale(1.1); }
        .btn-ar    { transition:all 0.2s; }
        .btn-ar:hover  { background:#00cc6a!important; transform:translateY(-1px); box-shadow:0 8px 24px rgba(0,255,136,0.3)!important; }
        .btn-ar:active { transform:scale(0.97); }
      `}</style>

      {/* Background grid */}
      <div style={{
        position:"fixed", inset:0, zIndex:0, pointerEvents:"none",
        backgroundImage:"linear-gradient(rgba(0,255,136,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,136,0.05) 1px,transparent 1px)",
        backgroundSize:"40px 40px", animation:"gridPulse 4s ease-in-out infinite"
      }} />

      {toast && <Toast {...toast} onDone={() => setToast(null)} />}

      <div style={{ position:"relative", zIndex:1, width:"100%", maxWidth:460, animation:"fadeUp 0.5s ease" }}>

        {/* Header */}
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ fontSize:10, letterSpacing:6, color:"#00ff8877", marginBottom:10 }}>
            WEBXR · ARCORE · ARKIT
          </div>
          <h1 style={{ fontSize:24, color:"#fff", margin:0, fontWeight:300, letterSpacing:4, lineHeight:1.3 }}>
            CAD <span style={{ color:"#00ff88", fontWeight:700 }}>OVERLAY</span>
          </h1>
          <p style={{ color:"#334433", fontSize:10, marginTop:8, letterSpacing:2, margin:"8px 0 0" }}>
            REAL-WORLD AR · STL ALIGNMENT
          </p>
        </div>

        {/* Drop zone */}
        <div className="dz" onDrop={onDrop} onDragOver={e => e.preventDefault()}
          onClick={() => document.getElementById("stl-input").click()}
          style={{
            border:"1px dashed #1a321a", borderRadius:16, padding:"28px 20px",
            textAlign:"center", cursor:"pointer", background:"#0a120a",
            transition:"all 0.25s", marginBottom:14
          }}>
          <input id="stl-input" type="file" accept=".stl" style={{ display:"none" }}
            onChange={e => handleFile(e.target.files[0])} />

          {!parseInfo ? (
            <>
              <div className="dz-icon" style={{ fontSize:44, color:"#1e3e1e", marginBottom:14, transition:"all 0.2s" }}>⬡</div>
              <div style={{ color:"#3a5a3a", fontSize:12, lineHeight:2, letterSpacing:1 }}>
                DROP <span style={{ color:"#00ff88" }}>.STL</span> FILE HERE<br/>
                <span style={{ color:"#243424", fontSize:10 }}>or tap to browse</span>
              </div>
              {!threeReady && (
                <div style={{ marginTop:14, fontSize:10, color:"#3a5a3a", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                  <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>
                  LOADING 3D ENGINE
                </div>
              )}
            </>
          ) : (
            <div onClick={e => e.stopPropagation()}>
              <canvas ref={previewCanvasRef} width={280} height={280}
                style={{ borderRadius:10, display:"block", margin:"0 auto 14px", background:"transparent" }} />
              <div style={{ color:"#fff", fontSize:12, marginBottom:4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {parseInfo.name}
              </div>
              <div style={{ color:"#00ff88", fontSize:11, lineHeight:2 }}>
                {parseInfo.tris.toLocaleString()} triangles
              </div>
              <div style={{ color:"#334433", fontSize:10 }}>
                {parseInfo.w} × {parseInfo.h} × {parseInfo.d} mm
              </div>
              <div style={{ marginTop:10, fontSize:9, color:"#1e2e1e", borderTop:"1px solid #142014", paddingTop:10 }}>
                TAP TO REPLACE FILE
              </div>
            </div>
          )}
          {parseError && (
            <div style={{ marginTop:10, color:"#ff6644", fontSize:11 }}>{parseError}</div>
          )}
        </div>

        {/* XR support badge */}
        <div style={{ textAlign:"center", marginBottom:14, minHeight:32 }}>
          {xrSupported === null && (
            <div style={{ color:"#334433", fontSize:10, letterSpacing:1 }}>
              <span style={{ animation:"spin 1s linear infinite", display:"inline-block", marginRight:6 }}>◌</span>
              CHECKING AR SUPPORT
            </div>
          )}
          {xrSupported === true && (
            <div style={{ color:"#00ff88", fontSize:10, letterSpacing:1 }}>✓ AR SUPPORTED ON THIS DEVICE</div>
          )}
          {xrSupported === false && (
            <div style={{ color:"#ff6644", fontSize:10, letterSpacing:1, lineHeight:2 }}>
              ⚠ WebXR AR not detected<br/>
              <span style={{ color:"#334433", fontSize:9 }}>
                Android: Chrome 81+ &nbsp;|&nbsp; iOS: Safari 16+<br/>
                Must be on HTTPS (netlify.app ✓)
              </span>
            </div>
          )}
        </div>

        {/* Launch AR button */}
        {parseInfo && (
          <button className="btn-ar" onClick={startAR}
            disabled={xrSupported === false}
            style={{
              width:"100%", padding:"16px", borderRadius:10,
              background: xrSupported === false ? "#111a11" : "#00ff88",
              color: xrSupported === false ? "#334433" : "#000",
              border:"none", fontSize:13, fontWeight:700,
              cursor: xrSupported === false ? "not-allowed" : "pointer",
              letterSpacing:3, fontFamily:"'JetBrains Mono',monospace",
              boxShadow: xrSupported !== false ? "0 4px 20px rgba(0,255,136,0.25)" : "none",
              transition:"all 0.2s"
            }}>
            {initStatus || (xrSupported === false ? "AR NOT AVAILABLE" : "▶  LAUNCH AR")}
          </button>
        )}

        {/* AR Error */}
        {arError && (
          <div style={{
            marginTop:14, background:"#120808", border:"1px solid #ff444433",
            borderRadius:10, padding:"14px 16px", color:"#ff6644",
            fontSize:11, lineHeight:1.9
          }}>
            <div style={{ fontWeight:700, marginBottom:4 }}>⚠ {arError}</div>
            {arError.includes("HTTPS") && (
              <div style={{ color:"#334433", fontSize:10 }}>
                You are on <span style={{ color:"#00ff88" }}>https://realtracking.netlify.app</span> ✓<br/>
                Try reloading and allowing camera access.
              </div>
            )}
            {arError.includes("permission") && (
              <div style={{ color:"#334433", fontSize:10 }}>
                Go to browser Settings → Site permissions → Camera → Allow
              </div>
            )}
          </div>
        )}

        {/* Feature chips */}
        <div style={{ display:"flex", gap:8, marginTop:20, flexWrap:"wrap", justifyContent:"center" }}>
          {["ARCore / ARKit", "6DoF Tracking", "Hit-Test", "No OpenCV"].map(t => (
            <div key={t} style={{
              padding:"4px 10px", borderRadius:20, border:"1px solid #1a2e1a",
              color:"#3a5a3a", fontSize:9, letterSpacing:1
            }}>{t}</div>
          ))}
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════
  // ── RENDER: AR SCREEN ──
  // Canvas mounts here → useEffect fires → initARSession() runs safely
  // ════════════════════════════════════════════
  return (
    <div style={{ position:"relative", width:"100vw", height:"100vh", overflow:"hidden", background:"#000" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&display=swap');
        @keyframes toastIn  { from{opacity:0;transform:translate(-50%,-12px) scale(0.9)} to{opacity:1;transform:translate(-50%,0) scale(1)} }
        @keyframes scanRing { 0%{transform:scale(0.4);opacity:0.8} 100%{transform:scale(2);opacity:0} }
        @keyframes blink    { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeIn   { from{opacity:0} to{opacity:1} }
        @keyframes slideUp  { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin     { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        .btn-place:active   { transform:scale(0.95)!important; }
        .btn-sm:active      { transform:scale(0.95); }
      `}</style>

      {toast && <Toast {...toast} onDone={() => setToast(null)} />}

      {/* ── THREE.JS / WebXR CANVAS — this is what useEffect waits for ── */}
      <canvas ref={canvasRef}
        style={{ position:"absolute", inset:0, width:"100%", height:"100%" }} />

      {/* ── DOM OVERLAY — all UI on top of AR camera feed ── */}
      <div id="ar-overlay" style={{ position:"absolute", inset:0, pointerEvents:"none" }}>

        {/* Gesture capture — only active when model is placed */}
        <div ref={gestureLayerRef} style={{
          position:"absolute", inset:0,
          pointerEvents: isPlaced ? "auto" : "none",
          touchAction:"none"
        }} />

        {/* ── TOP BAR ── */}
        <div style={{
          position:"absolute", top:0, left:0, right:0,
          background:"rgba(0,0,0,0.6)", backdropFilter:"blur(12px)",
          padding:"12px 16px", display:"flex", alignItems:"center",
          justifyContent:"space-between", pointerEvents:"auto",
          borderBottom:"1px solid rgba(0,255,136,0.08)"
        }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:"#00ff88", letterSpacing:4 }}>
            CAD · AR
          </div>
          <div style={{ display:"flex", gap:12, fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:"#00ff8888" }}>
            <span><span style={{ color:"#223322" }}>S:</span>{transform.scale.toFixed(3)}</span>
            <span><span style={{ color:"#223322" }}>Ry:</span>{(transform.rotY * 180/Math.PI).toFixed(0)}°</span>
          </div>
          <button className="btn-sm"
            onClick={() => { cleanupAR(); setStep("upload"); setIsPlaced(false); setScanning(true); setArError(null); }}
            style={{
              background:"rgba(0,0,0,0.5)", border:"1px solid #1a2a1a",
              color:"#446644", padding:"6px 12px", borderRadius:6,
              fontSize:10, fontFamily:"'JetBrains Mono',monospace",
              cursor:"pointer", letterSpacing:1, pointerEvents:"auto"
            }}>← EXIT</button>
        </div>

        {/* ── INIT LOADING ── */}
        {initStatus !== "" && (
          <div style={{
            position:"absolute", top:"50%", left:"50%",
            transform:"translate(-50%,-50%)", textAlign:"center",
            pointerEvents:"none"
          }}>
            <div style={{
              fontFamily:"'JetBrains Mono',monospace", fontSize:11,
              color:"#00ff88", letterSpacing:2,
              display:"flex", alignItems:"center", gap:8
            }}>
              <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>
              {initStatus}
            </div>
          </div>
        )}

        {/* ── SCANNING GUIDANCE ── */}
        {!isPlaced && initStatus === "" && (
          <div style={{
            position:"absolute", top:"50%", left:"50%",
            transform:"translate(-50%,-50%)",
            textAlign:"center", pointerEvents:"none",
            animation:"fadeIn 0.5s ease"
          }}>
            {scanning && (
              <>
                <ScanRing />
                <div style={{
                  fontFamily:"'JetBrains Mono',monospace", fontSize:11,
                  color:"#00ff88", letterSpacing:3,
                  animation:"blink 1.5s ease-in-out infinite"
                }}>SCANNING SURFACE</div>
                <div style={{ color:"#334433", fontSize:9, marginTop:8, letterSpacing:1 }}>
                  Move camera slowly over a flat surface
                </div>
              </>
            )}
            {!scanning && hitAvailable && (
              <div style={{
                fontFamily:"'JetBrains Mono',monospace", fontSize:12,
                color:"#00ff88", letterSpacing:2
              }}>✦ SURFACE DETECTED</div>
            )}
          </div>
        )}

        {/* ── PLACE BUTTON — appears when surface detected ── */}
        {!isPlaced && hitAvailable && initStatus === "" && (
          <div style={{
            position:"absolute", bottom:130, left:"50%", transform:"translateX(-50%)",
            pointerEvents:"auto", animation:"slideUp 0.4s cubic-bezier(0.34,1.56,0.64,1)"
          }}>
            <button className="btn-place" onClick={placeModel} style={{
              padding:"18px 52px", borderRadius:50,
              background:"#00ff88", color:"#000",
              border:"none", fontSize:14, fontWeight:700,
              cursor:"pointer", letterSpacing:3,
              fontFamily:"'JetBrains Mono',monospace",
              boxShadow:"0 8px 32px rgba(0,255,136,0.45)",
              transition:"all 0.15s"
            }}>
              ⊕ PLACE MODEL
            </button>
          </div>
        )}

        {/* ── POST-PLACEMENT UI ── */}
        {isPlaced && (
          <>
            {/* Placed badge */}
            <div style={{
              position:"absolute", top:68, left:"50%", transform:"translateX(-50%)",
              background:"rgba(0,255,136,0.08)", border:"1px solid #00ff8822",
              borderRadius:20, padding:"4px 16px",
              fontFamily:"'JetBrains Mono',monospace", fontSize:9,
              color:"#00ff88", letterSpacing:2, pointerEvents:"none",
              animation:"fadeIn 0.3s ease"
            }}>
              ● MODEL PLACED
            </div>

            {/* Controls + reposition */}
            <div style={{
              position:"absolute", bottom:32, left:"50%", transform:"translateX(-50%)",
              display:"flex", flexDirection:"column", alignItems:"center", gap:12,
              pointerEvents:"auto", animation:"slideUp 0.4s ease"
            }}>
              <div style={{
                background:"rgba(0,0,0,0.7)", backdropFilter:"blur(10px)",
                borderRadius:14, padding:"12px 24px", border:"1px solid #1a2a1a",
                display:"flex", gap:24
              }}>
                {[["👆","Drag","Rotate Y"],["🤏","Pinch","Scale"]].map(([ic,k,v]) => (
                  <div key={k} style={{ textAlign:"center" }}>
                    <div style={{ fontSize:20, marginBottom:4 }}>{ic}</div>
                    <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:9, color:"#00ff88", letterSpacing:1 }}>{v}</div>
                    <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:8, color:"#223322" }}>{k}</div>
                  </div>
                ))}
              </div>
              <button className="btn-place" onClick={repositionModel} style={{
                padding:"12px 36px", borderRadius:50,
                background:"rgba(0,0,0,0.65)", border:"1px solid #00ff8833",
                color:"#00ff88", fontSize:11, fontWeight:700,
                cursor:"pointer", letterSpacing:2,
                fontFamily:"'JetBrains Mono',monospace",
                transition:"all 0.15s"
              }}>↺ REPOSITION</button>
            </div>
          </>
        )}

        {/* ── FOV TUNER (top-right, for fine-tuning scale) ── */}
        <div style={{ position:"absolute", top:68, right:16, pointerEvents:"auto" }}>
          <button onClick={() => setShowFovTuner(s => !s)} style={{
            background:"rgba(0,0,0,0.6)", border:"1px solid #1a2a1a",
            color:"#3a5a3a", padding:"6px 12px", borderRadius:6,
            fontSize:9, fontFamily:"'JetBrains Mono',monospace",
            cursor:"pointer", letterSpacing:1
          }}>⊙ FOV</button>

          {showFovTuner && (
            <div style={{
              marginTop:8, background:"rgba(0,0,0,0.85)",
              border:"1px solid #1a2a1a", borderRadius:10,
              padding:"14px 16px", minWidth:160,
              animation:"fadeIn 0.2s ease"
            }}>
              <div style={{ color:"#00ff88", fontSize:9, letterSpacing:2, marginBottom:10, fontFamily:"'JetBrains Mono',monospace" }}>
                FOV: {fov}°
              </div>
              <input type="range" min={40} max={110} value={fov} step={1}
                onChange={e => {
                  const v = parseInt(e.target.value);
                  setFov(v);
                  if (cameraRef.current) {
                    cameraRef.current.fov = v;
                    cameraRef.current.updateProjectionMatrix();
                  }
                }}
                style={{ width:"100%", accentColor:"#00ff88" }}
              />
              <div style={{ color:"#223322", fontSize:8, marginTop:6, fontFamily:"'JetBrains Mono',monospace", display:"flex", justifyContent:"space-between" }}>
                <span>40° NARROW</span><span>110° WIDE</span>
              </div>
              <div style={{ color:"#334433", fontSize:8, marginTop:8, fontFamily:"'JetBrains Mono',monospace", lineHeight:1.6 }}>
                Adjust if model scale<br/>looks wrong on screen
              </div>
            </div>
          )}
        </div>

      </div>{/* end ar-overlay */}
    </div>
  );
}
