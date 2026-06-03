// ── CAD OVERLAY APP — WebXR Edition ──
// STL Upload → WebXR AR Session → Manual Placement → Anchor Lock
// Uses ARCore (Android) / ARKit (iOS) via navigator.xr

import { useState, useRef, useEffect, useCallback } from "react";

// ── SCRIPT LOADER ──
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── TOAST ──
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

// ── SCAN ANIMATION ──
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

// ── MAIN APP ──
export default function CADOverlayApp() {

  // ── STATE ──
  const [step, setStep] = useState("upload");
  // upload | checking | ar | placed | error
  const [threeReady, setThreeReady] = useState(false);
  const [xrSupported, setXrSupported] = useState(null); // null=checking, true, false
  const [parseInfo, setParseInfo] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [arError, setArError] = useState(null);
  const [toast, setToast] = useState(null);
  const [transform, setTransform] = useState({ scale:1, rotY:0 });
  const [isPlaced, setIsPlaced] = useState(false);
  const [hitAvailable, setHitAvailable] = useState(false);
  const [scanning, setScanning] = useState(true);
  const [fov, setFov] = useState(70);
  const [showFovTuner, setShowFovTuner] = useState(false);

  // ── REFS ──
  const canvasRef           = useRef(null);
  const geometryRef         = useRef(null);
  const previewCanvasRef    = useRef(null);
  const previewAnimRef      = useRef(null);
  const rendererPreviewRef  = useRef(null);

  // WebXR / Three.js refs
  const rendererRef         = useRef(null);
  const sceneRef            = useRef(null);
  const cameraRef           = useRef(null);
  const meshRef             = useRef(null);
  const reticleMeshRef      = useRef(null);
  const xrSessionRef        = useRef(null);
  const xrRefSpaceRef       = useRef(null);
  const hitTestSrcRef       = useRef(null);
  const animFrameRef        = useRef(null);
  const transformRef        = useRef({ scale:1, rotY:0 });
  const placedRef           = useRef(false);
  const lastTouchRef        = useRef(null);
  const lastPinchRef        = useRef(null);
  const lastAngleRef        = useRef(null);
  const gestureLayerRef     = useRef(null);

  // ── LOAD THREE.JS ──
  useEffect(() => {
    async function load() {
      try {
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js");
        await loadScript("https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js");
        setThreeReady(true);
      } catch(e) { console.error("Three.js failed", e); }

      // Check WebXR support
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
    return () => cleanupAR();
  }, []);

  // ── STL PARSE ──
  const handleFile = useCallback((file) => {
    if (!file || !file.name.toLowerCase().endsWith(".stl")) {
      setParseError("Only .stl files accepted."); return;
    }
    if (!threeReady) { setParseError("3D engine loading..."); return; }
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
      } catch { setParseError("Invalid STL file. Try another file."); }
    };
    reader.readAsArrayBuffer(file);
  }, [threeReady]);

  function initPreview(geo) {
    const canvas = previewCanvasRef.current; if(!canvas) return;
    const THREE = window.THREE;
    if (rendererPreviewRef.current) {
      rendererPreviewRef.current.dispose();
      cancelAnimationFrame(previewAnimRef.current);
    }
    const renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true });
    renderer.setSize(280, 280); renderer.setClearColor(0,0);
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

  // ── START WebXR AR SESSION ──
  async function startAR() {
    setArError(null);
    const THREE = window.THREE;

    try {
      // ── Init Three.js renderer on the canvas ──
      const canvas = canvasRef.current;
      if (rendererRef.current) { rendererRef.current.dispose(); }

      const renderer = new THREE.WebGLRenderer({
        canvas, alpha: true, antialias: true,
        powerPreference: "high-performance"
      });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.xr.enabled = true;
      renderer.setClearColor(0x000000, 0);
      rendererRef.current = renderer;

      // ── Scene setup ──
      const scene = new THREE.Scene();
      sceneRef.current = scene;

      // Lighting
      scene.add(new THREE.AmbientLight(0xffffff, 0.8));
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
      dirLight.position.set(1, 2, 3);
      scene.add(dirLight);

      // Camera (WebXR will control this)
      const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
      cameraRef.current = camera;

      // ── STL Wireframe Mesh ──
      const geo = geometryRef.current;
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const maxDim = Math.max(bb.max.x-bb.min.x, bb.max.y-bb.min.y, bb.max.z-bb.min.z);
      // Scale so model ≈ 0.3 meters in real world
      const worldScale = 0.3 / maxDim;

      const wireGeo = new THREE.WireframeGeometry(geo);
      const wireMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 1.5 });
      const mesh = new THREE.LineSegments(wireGeo, wireMat);
      mesh.scale.setScalar(worldScale);
      mesh.visible = false; // hidden until placed
      scene.add(mesh);
      meshRef.current = mesh;

      // Axes helper on model
      const axes = new THREE.AxesHelper(0.15);
      mesh.add(axes);

      // ── Reticle (placement target) ──
      const reticleGeo = new THREE.RingGeometry(0.08, 0.12, 32);
      reticleGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      const reticleMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide });
      const reticle = new THREE.Mesh(reticleGeo, reticleMat);
      reticle.visible = false;
      scene.add(reticle);
      reticleMeshRef.current = reticle;

      // ── Request WebXR session ──
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["dom-overlay", "anchors"],
        domOverlay: { root: document.getElementById("ar-overlay") }
      });
      xrSessionRef.current = session;

      renderer.xr.setReferenceSpaceType("local");
      await renderer.xr.setSession(session);

      // ── Reference space ──
      const refSpace = await session.requestReferenceSpace("local");
      xrRefSpaceRef.current = refSpace;

      // ── Hit test source ──
      const viewerSpace = await session.requestReferenceSpace("viewer");
      const hitTestSrc = await session.requestHitTestSource({ space: viewerSpace });
      hitTestSrcRef.current = hitTestSrc;

      // ── Set initial transform ──
      transformRef.current = { scale: worldScale, rotY: 0 };
      setTransform({ scale: worldScale, rotY: 0 });
      placedRef.current = false;
      setIsPlaced(false);
      setScanning(true);

      setStep("ar");

      // ── XR Render Loop ──
      renderer.setAnimationLoop((timestamp, frame) => {
        if (!frame) return;

        const session = xrSessionRef.current;
        const refSpace = xrRefSpaceRef.current;
        const hitSrc = hitTestSrcRef.current;

        // ── Hit test — move reticle ──
        if (hitSrc && !placedRef.current) {
          const hits = frame.getHitTestResults(hitSrc);
          if (hits.length > 0) {
            const hit = hits[0];
            const pose = hit.getPose(refSpace);
            if (pose) {
              reticle.visible = true;
              reticle.matrix.fromArray(pose.transform.matrix);
              reticle.matrixAutoUpdate = false;
              setHitAvailable(true);
              setScanning(false);
            }
          } else {
            reticle.visible = false;
            setHitAvailable(false);
          }
        }

        // ── Apply WebXR camera pose to Three.js camera ──
        const pose = frame.getViewerPose(refSpace);
        if (pose) {
          const view = pose.views[0];
          // Use real camera projection matrix from device
          camera.projectionMatrix.fromArray(view.projectionMatrix);
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
          // Use real camera world transform
          const viewMatrix = view.transform.inverse.matrix;
          camera.matrix.fromArray(view.transform.matrix);
          camera.matrixWorldNeedsUpdate = true;
        }

        renderer.render(scene, camera);
      });

      session.addEventListener("end", () => {
        cleanupAR();
        setStep("upload");
        setToast({ message: "AR session ended", type: "info" });
      });

    } catch(err) {
      console.error("WebXR error:", err);
      setArError(
        err.name === "NotSupportedError" ? "AR not supported on this device." :
        err.name === "SecurityError" ? "HTTPS required for AR. Use ngrok or deploy to HTTPS." :
        err.name === "NotAllowedError" ? "Camera permission denied." :
        "AR failed: " + err.message
      );
    }
  }

  // ── PLACE MODEL on tap ──
  function placeModel() {
    const reticle = reticleMeshRef.current;
    const mesh = meshRef.current;
    if (!reticle || !reticle.visible || !mesh) return;

    // Copy reticle world matrix to mesh position
    const THREE = window.THREE;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    reticle.matrix.decompose(pos, quat, scale);

    mesh.position.copy(pos);
    mesh.quaternion.copy(quat);
    mesh.scale.setScalar(transformRef.current.scale);
    mesh.rotation.y += transformRef.current.rotY;
    mesh.visible = true;

    reticle.visible = false;
    placedRef.current = true;
    setIsPlaced(true);
    setHitAvailable(false);
    setToast({ message: "✅ Model placed! Adjust with gestures.", type: "success" });
  }

  // ── REPOSITION (move model again) ──
  function repositionModel() {
    const mesh = meshRef.current;
    const reticle = reticleMeshRef.current;
    if (!mesh || !reticle) return;
    mesh.visible = false;
    reticle.visible = false;
    placedRef.current = false;
    setIsPlaced(false);
    setScanning(true);
    setHitAvailable(false);
    setToast({ message: "Move camera to scan surface", type: "info" });
  }

  // ── GESTURES (after placement) ──
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
        // Single drag = rotate Y
        const dx = e.touches[0].clientX - lastTouchRef.current.x;
        mesh.rotation.y += dx * 0.01;
        transformRef.current.rotY = mesh.rotation.y;
        lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        setTransform(t => ({ ...t, rotY: mesh.rotation.y }));

      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);

        if (lastPinchRef.current) {
          const ratio = dist / lastPinchRef.current;
          const ns = transformRef.current.scale * ratio;
          if (ns > 0.001 && ns < 10) {
            mesh.scale.setScalar(ns);
            transformRef.current.scale = ns;
            setTransform(t => ({ ...t, scale: ns }));
          }
        }
        lastPinchRef.current = dist;
        lastAngleRef.current = angle;
      }
    };

    const onTE = () => {
      lastTouchRef.current = null;
      lastPinchRef.current = null;
      lastAngleRef.current = null;
    };

    el.addEventListener("touchstart", onTS, { passive: false });
    el.addEventListener("touchmove", onTM, { passive: false });
    el.addEventListener("touchend", onTE);
    return () => {
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchmove", onTM);
      el.removeEventListener("touchend", onTE);
    };
  }, [step]);

  // ── CLEANUP ──
  function cleanupAR() {
    if (rendererRef.current) {
      rendererRef.current.setAnimationLoop(null);
      rendererRef.current.dispose();
      rendererRef.current = null;
    }
    if (hitTestSrcRef.current) { try { hitTestSrcRef.current.cancel(); } catch{} hitTestSrcRef.current = null; }
    if (xrSessionRef.current) { try { xrSessionRef.current.end(); } catch{} xrSessionRef.current = null; }
    cancelAnimationFrame(previewAnimRef.current);
    if (rendererPreviewRef.current) { rendererPreviewRef.current.dispose(); rendererPreviewRef.current = null; }
  }

  const onDrop = (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); };

  // ─────────────────────────────────────────────
  // ── RENDER: UPLOAD SCREEN ──
  // ─────────────────────────────────────────────
  if (step === "upload") return (
    <div style={{
      minHeight:"100vh", background:"#080c08",
      display:"flex", flexDirection:"column", alignItems:"center",
      justifyContent:"center", padding:"24px 16px",
      fontFamily:"'JetBrains Mono','Courier New',monospace"
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&display=swap');
        @keyframes toastIn { from{opacity:0;transform:translate(-50%,-12px) scale(0.9)} to{opacity:1;transform:translate(-50%,0) scale(1)} }
        @keyframes scanRing { 0%{transform:scale(0.4);opacity:0.8} 100%{transform:scale(2);opacity:0} }
        @keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes gridPulse { 0%,100%{opacity:0.03} 50%{opacity:0.07} }
        .dz:hover { border-color:#00ff88 !important; background:rgba(0,255,136,0.04) !important; }
        .dz:hover .dz-icon { color:#00ff88 !important; transform:scale(1.1); }
        .btn-ar { transition:all 0.2s; }
        .btn-ar:hover { background:#00cc6a !important; transform:translateY(-1px); box-shadow:0 8px 24px rgba(0,255,136,0.3) !important; }
        .btn-ar:active { transform:scale(0.97); }
      `}</style>

      {/* Grid background */}
      <div style={{
        position:"fixed", inset:0, zIndex:0, pointerEvents:"none",
        backgroundImage:"linear-gradient(rgba(0,255,136,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,136,0.05) 1px,transparent 1px)",
        backgroundSize:"40px 40px", animation:"gridPulse 4s ease-in-out infinite"
      }} />

      {toast && <Toast {...toast} onDone={() => setToast(null)} />}

      <div style={{ position:"relative", zIndex:1, width:"100%", maxWidth:460, animation:"fadeUp 0.6s ease" }}>

        {/* Header */}
        <div style={{ textAlign:"center", marginBottom:36 }}>
          <div style={{ fontSize:10, letterSpacing:6, color:"#00ff8899", marginBottom:10 }}>
            WEBXR · ARCORE · ARKIT
          </div>
          <h1 style={{ fontSize:24, color:"#fff", margin:0, fontWeight:300, letterSpacing:4, lineHeight:1.3 }}>
            CAD <span style={{ color:"#00ff88", fontWeight:700 }}>OVERLAY</span>
          </h1>
          <p style={{ color:"#445", fontSize:10, marginTop:8, letterSpacing:2 }}>
            REAL-WORLD AR · STL ALIGNMENT
          </p>
        </div>

        {/* Drop zone */}
        <div className="dz" onDrop={onDrop} onDragOver={e=>e.preventDefault()}
          onClick={() => document.getElementById("stl-input").click()}
          style={{
            border:"1px dashed #1e3a1e", borderRadius:16, padding:"28px 20px",
            textAlign:"center", cursor:"pointer", background:"#0a120a",
            transition:"all 0.25s", marginBottom:16
          }}>
          <input id="stl-input" type="file" accept=".stl" style={{ display:"none" }}
            onChange={e => handleFile(e.target.files[0])} />

          {!parseInfo ? (
            <>
              <div className="dz-icon" style={{ fontSize:44, color:"#1e4a1e", marginBottom:14, transition:"all 0.2s" }}>⬡</div>
              <div style={{ color:"#446644", fontSize:12, lineHeight:2, letterSpacing:1 }}>
                DROP <span style={{ color:"#00ff88" }}>.STL</span> FILE HERE<br/>
                <span style={{ color:"#2a3a2a", fontSize:10 }}>or click to browse</span>
              </div>
              {!threeReady && (
                <div style={{ marginTop:14, fontSize:10, color:"#446644", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
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
              <div style={{ color:"#445", fontSize:10 }}>
                {parseInfo.w} × {parseInfo.h} × {parseInfo.d} mm
              </div>
              <div style={{ marginTop:10, fontSize:9, color:"#2a3a2a", borderTop:"1px solid #1a2a1a", paddingTop:10 }}>
                CLICK TO REPLACE
              </div>
            </div>
          )}
          {parseError && <div style={{ marginTop:10, color:"#ff6644", fontSize:11 }}>{parseError}</div>}
        </div>

        {/* WebXR support status */}
        <div style={{ textAlign:"center", marginBottom:16 }}>
          {xrSupported === null && (
            <div style={{ color:"#445", fontSize:10, letterSpacing:1 }}>
              <span style={{ animation:"spin 1s linear infinite", display:"inline-block", marginRight:6 }}>◌</span>
              CHECKING AR SUPPORT
            </div>
          )}
          {xrSupported === true && (
            <div style={{ color:"#00ff88", fontSize:10, letterSpacing:1 }}>✓ AR SUPPORTED ON THIS DEVICE</div>
          )}
          {xrSupported === false && (
            <div style={{ color:"#ff6644", fontSize:10, letterSpacing:1, lineHeight:1.8 }}>
              ⚠ WebXR AR not supported<br/>
              <span style={{ color:"#445", fontSize:9 }}>
                Requires Android Chrome 81+ or iOS Safari 16+<br/>
                and HTTPS (use ngrok for local testing)
              </span>
            </div>
          )}
        </div>

        {/* Start AR button */}
        {parseInfo && (
          <button className="btn-ar" onClick={startAR}
            disabled={xrSupported === false}
            style={{
              width:"100%", padding:"16px", borderRadius:10,
              background: xrSupported === false ? "#1a2a1a" : "#00ff88",
              color: xrSupported === false ? "#445" : "#000",
              border:"none", fontSize:13, fontWeight:700, cursor: xrSupported === false ? "not-allowed" : "pointer",
              letterSpacing:3, fontFamily:"'JetBrains Mono',monospace",
              boxShadow: xrSupported !== false ? "0 4px 20px rgba(0,255,136,0.2)" : "none"
            }}>
            {xrSupported === false ? "AR NOT AVAILABLE" : "▶  LAUNCH AR"}
          </button>
        )}

        {arError && (
          <div style={{
            marginTop:14, background:"#1a0a0a", border:"1px solid #ff444444",
            borderRadius:10, padding:"12px 16px", color:"#ff6644", fontSize:11, lineHeight:1.8
          }}>
            {arError}
            {arError.includes("ngrok") && (
              <div style={{ marginTop:8, color:"#445", fontSize:10 }}>
                Run: <span style={{ color:"#00ff88" }}>npx ngrok http 5173</span><br/>
                Then open the https:// URL on your phone
              </div>
            )}
          </div>
        )}

        {/* WebXR info chips */}
        <div style={{ display:"flex", gap:8, marginTop:20, flexWrap:"wrap", justifyContent:"center" }}>
          {["ARCore / ARKit", "6DoF Tracking", "Hit-Test Placement", "No OpenCV"].map(t => (
            <div key={t} style={{
              padding:"4px 10px", borderRadius:20, border:"1px solid #1e3a1e",
              color:"#446644", fontSize:9, letterSpacing:1
            }}>{t}</div>
          ))}
        </div>
      </div>
    </div>
  );

  // ─────────────────────────────────────────────
  // ── RENDER: AR SCREEN ──
  // ─────────────────────────────────────────────
  return (
    <div style={{ position:"relative", width:"100vw", height:"100vh", overflow:"hidden", background:"#000" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&display=swap');
        @keyframes toastIn { from{opacity:0;transform:translate(-50%,-12px) scale(0.9)} to{opacity:1;transform:translate(-50%,0) scale(1)} }
        @keyframes scanRing { 0%{transform:scale(0.4);opacity:0.8} 100%{transform:scale(2);opacity:0} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes slideUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        .btn-place { transition:all 0.15s; }
        .btn-place:active { transform:scale(0.95); }
        .btn-sm:active { transform:scale(0.95); }
      `}</style>

      {toast && <Toast {...toast} onDone={() => setToast(null)} />}

      {/* WebXR canvas — Three.js renders here, camera feed is automatic */}
      <canvas ref={canvasRef} style={{ position:"absolute", inset:0, width:"100%", height:"100%" }} />

      {/* DOM Overlay — UI on top of AR */}
      <div id="ar-overlay" style={{ position:"absolute", inset:0, pointerEvents:"none" }}>

        {/* Gesture capture layer (pointer events only when placed) */}
        <div ref={gestureLayerRef} style={{
          position:"absolute", inset:0,
          pointerEvents: isPlaced ? "auto" : "none",
          touchAction:"none"
        }} />

        {/* ── TOP BAR ── */}
        <div style={{
          position:"absolute", top:0, left:0, right:0,
          background:"rgba(0,0,0,0.55)", backdropFilter:"blur(12px)",
          padding:"12px 16px", display:"flex", alignItems:"center",
          justifyContent:"space-between", pointerEvents:"auto",
          borderBottom:"1px solid rgba(0,255,136,0.1)"
        }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:"#00ff88", letterSpacing:4 }}>
            CAD · AR
          </div>
          <div style={{ display:"flex", gap:10, fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:"#00ff8899" }}>
            <span><span style={{ color:"#334" }}>S:</span>{transform.scale.toFixed(3)}</span>
            <span><span style={{ color:"#334" }}>Ry:</span>{(transform.rotY * 180/Math.PI).toFixed(0)}°</span>
          </div>
          <button className="btn-sm" onClick={() => { cleanupAR(); setStep("upload"); setIsPlaced(false); setScanning(true); }}
            style={{
              background:"rgba(255,255,255,0.05)", border:"1px solid #1a2a1a",
              color:"#556655", padding:"6px 12px", borderRadius:6,
              fontSize:10, fontFamily:"'JetBrains Mono',monospace",
              cursor:"pointer", letterSpacing:1, pointerEvents:"auto"
            }}>← EXIT</button>
        </div>

        {/* ── SCANNING STATE — center reticle guidance ── */}
        {!isPlaced && (
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
                <div style={{ color:"#445", fontSize:9, marginTop:6, letterSpacing:1 }}>
                  Move camera slowly over a flat surface
                </div>
              </>
            )}
            {!scanning && hitAvailable && (
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:"#00ff88", letterSpacing:2 }}>
                ✦ SURFACE DETECTED
              </div>
            )}
          </div>
        )}

        {/* ── PLACE BUTTON ── */}
        {!isPlaced && hitAvailable && (
          <div style={{
            position:"absolute", bottom:120, left:"50%", transform:"translateX(-50%)",
            pointerEvents:"auto", animation:"slideUp 0.4s cubic-bezier(0.34,1.56,0.64,1)"
          }}>
            <button className="btn-place" onClick={placeModel} style={{
              padding:"18px 48px", borderRadius:50,
              background:"#00ff88", color:"#000",
              border:"none", fontSize:14, fontWeight:700,
              cursor:"pointer", letterSpacing:3,
              fontFamily:"'JetBrains Mono',monospace",
              boxShadow:"0 8px 32px rgba(0,255,136,0.4)"
            }}>
              ⊕ PLACE MODEL
            </button>
          </div>
        )}

        {/* ── PLACED: CONTROLS HINT + REPOSITION ── */}
        {isPlaced && (
          <>
            {/* Controls bottom */}
            <div style={{
              position:"absolute", bottom:24, left:"50%", transform:"translateX(-50%)",
              display:"flex", flexDirection:"column", alignItems:"center", gap:12,
              pointerEvents:"auto", animation:"slideUp 0.4s ease"
            }}>
              {/* Gesture hints */}
              <div style={{
                background:"rgba(0,0,0,0.65)", backdropFilter:"blur(10px)",
                borderRadius:12, padding:"10px 20px", border:"1px solid #1a2a1a",
                display:"flex", gap:20
              }}>
                {[["👆", "Drag", "Rotate"], ["🤏", "Pinch", "Scale"]].map(([ic, k, v]) => (
                  <div key={k} style={{ textAlign:"center" }}>
                    <div style={{ fontSize:18, marginBottom:2 }}>{ic}</div>
                    <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:9, color:"#00ff88", letterSpacing:1 }}>{v}</div>
                    <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:8, color:"#334", letterSpacing:1 }}>{k}</div>
                  </div>
                ))}
              </div>

              {/* Reposition button */}
              <button className="btn-place" onClick={repositionModel} style={{
                padding:"12px 32px", borderRadius:50,
                background:"rgba(0,0,0,0.6)", border:"1px solid #00ff8844",
                color:"#00ff88", fontSize:11, fontWeight:700, cursor:"pointer",
                letterSpacing:2, fontFamily:"'JetBrains Mono',monospace"
              }}>
                ↺ REPOSITION
              </button>
            </div>

            {/* Placed indicator top */}
            <div style={{
              position:"absolute", top:72, left:"50%", transform:"translateX(-50%)",
              background:"rgba(0,255,136,0.1)", border:"1px solid #00ff8833",
              borderRadius:20, padding:"4px 14px",
              fontFamily:"'JetBrains Mono',monospace", fontSize:9,
              color:"#00ff88", letterSpacing:2, pointerEvents:"none"
            }}>
              ● MODEL PLACED
            </div>
          </>
        )}

        {/* ── FOV Tuner (debug) ── */}
        <div style={{
          position:"absolute", top:72, right:16, pointerEvents:"auto"
        }}>
          <button onClick={() => setShowFovTuner(s => !s)} style={{
            background:"rgba(0,0,0,0.55)", border:"1px solid #1a2a1a",
            color:"#446644", padding:"6px 10px", borderRadius:6,
            fontSize:9, fontFamily:"'JetBrains Mono',monospace", cursor:"pointer", letterSpacing:1
          }}>FOV</button>
          {showFovTuner && (
            <div style={{
              marginTop:8, background:"rgba(0,0,0,0.8)", border:"1px solid #1a2a1a",
              borderRadius:10, padding:"12px 14px", minWidth:140
            }}>
              <div style={{ color:"#00ff88", fontSize:9, letterSpacing:2, marginBottom:8, fontFamily:"'JetBrains Mono',monospace" }}>
                FOV: {fov}°
              </div>
              <input type="range" min={40} max={100} value={fov} step={1}
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
              <div style={{ color:"#334", fontSize:8, marginTop:4, fontFamily:"'JetBrains Mono',monospace" }}>
                40° ←→ 100°
              </div>
            </div>
          )}
        </div>

      </div>{/* end ar-overlay */}
    </div>
  );
}
