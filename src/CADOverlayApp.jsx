// ── CAD OVERLAY APP — WebXR Edition (Full Transform Controls) ──
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
          animation:`scanRing 2s ease-out ${i*0.6}s infinite`, opacity:0
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

// ── TRANSFORM MODES ──
// MOVE    : 1-finger drag → move model on XZ plane (horizontal)
// ROTATE  : 1-finger drag → rotate Y; 2-finger drag → rotate X/Z
// SCALE   : pinch → scale uniformly
// ELEVATE : 1-finger drag up/down → move model up/down (Y axis)

const MODES = [
  { id:"move",    icon:"✥",  label:"Move",    hint:"Drag to move on surface" },
  { id:"rotate",  icon:"↻",  label:"Rotate",  hint:"Drag=Y  2-finger=X/Z" },
  { id:"scale",   icon:"⤡",  label:"Scale",   hint:"Pinch to scale" },
  { id:"elevate", icon:"↕",  label:"Elevate", hint:"Drag up/down to lift" },
];

export default function CADOverlayApp() {
  const [step, setStep]               = useState("upload");
  const [threeReady, setThreeReady]   = useState(false);
  const [xrSupported, setXrSupported] = useState(null);
  const [parseInfo, setParseInfo]     = useState(null);
  const [parseError, setParseError]   = useState(null);
  const [arError, setArError]         = useState(null);
  const [toast, setToast]             = useState(null);
  const [isPlaced, setIsPlaced]       = useState(false);
  const [hitAvailable, setHitAvailable] = useState(false);
  const [scanning, setScanning]       = useState(true);
  const [initStatus, setInitStatus]   = useState("");
  const [activeMode, setActiveMode]   = useState("move");
  const [showFov, setShowFov]         = useState(false);
  const [fov, setFov]                 = useState(70);
  const [liveTransform, setLiveTransform] = useState({ x:0, y:0, z:0, rx:0, ry:0, rz:0, s:1 });

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
  const placedRef          = useRef(false);
  const activeModeRef      = useRef("move");
  const gestureLayerRef    = useRef(null);

  // Touch tracking refs
  const touch1Ref          = useRef(null); // primary touch
  const touch2Ref          = useRef(null); // secondary touch
  const lastPinchDistRef   = useRef(null);
  const lastTwoAngleRef    = useRef(null);

  // ── SYNC activeMode to ref ──
  useEffect(() => { activeModeRef.current = activeMode; }, [activeMode]);

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
          const ok = await navigator.xr.isSessionSupported("immersive-ar");
          setXrSupported(ok);
        } catch { setXrSupported(false); }
      } else { setXrSupported(false); }
    }
    load();
    return () => { cleanupAR(); cancelAnimationFrame(previewAnimRef.current); rendererPreviewRef.current?.dispose(); };
  }, []);

  // ── KEY FIX: init AFTER canvas mounts ──
  useEffect(() => {
    if (step !== "ar") return;
    const t = setTimeout(() => initARSession(), 80);
    return () => { clearTimeout(t); cleanupAR(); };
  }, [step]);

  // ── STL PARSE ──
  const handleFile = useCallback((file) => {
    if (!file || !file.name.toLowerCase().endsWith(".stl")) { setParseError("Only .stl files accepted."); return; }
    if (!threeReady) { setParseError("3D engine loading..."); return; }
    setParseError(null); setParseInfo(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const THREE = window.THREE;
        const geo = new THREE.STLLoader().parse(e.target.result);
        geo.computeBoundingBox(); geo.center();
        const bb = geo.boundingBox;
        geometryRef.current = geo;
        setParseInfo({
          name: file.name,
          tris: Math.round(geo.attributes.position.count / 3),
          w: (bb.max.x-bb.min.x).toFixed(1),
          h: (bb.max.y-bb.min.y).toFixed(1),
          d: (bb.max.z-bb.min.z).toFixed(1),
        });
        setTimeout(() => initPreview(geo), 50);
      } catch { setParseError("Invalid STL. Try another file."); }
    };
    reader.readAsArrayBuffer(file);
  }, [threeReady]);

  function initPreview(geo) {
    const canvas = previewCanvasRef.current; if (!canvas) return;
    const THREE = window.THREE;
    if (rendererPreviewRef.current) { rendererPreviewRef.current.dispose(); cancelAnimationFrame(previewAnimRef.current); }
    const renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true });
    renderer.setSize(280, 280); renderer.setClearColor(0, 0);
    rendererPreviewRef.current = renderer;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    const sphere = new THREE.Sphere();
    new THREE.Box3().setFromObject(new THREE.Mesh(geo)).getBoundingSphere(sphere);
    cam.position.set(0, 0, sphere.radius * 2.8);
    const mesh = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color:0x00ff88 }));
    scene.add(mesh); scene.add(new THREE.AmbientLight(0xffffff, 1));
    const loop = () => {
      previewAnimRef.current = requestAnimationFrame(loop);
      mesh.rotation.y += 0.012;
      mesh.rotation.x = Math.sin(Date.now()*0.0005)*0.3;
      renderer.render(scene, cam);
    };
    loop();
  }

  // ── START AR: validate only, canvas not ready yet ──
  async function startAR() {
    setArError(null); setInitStatus("Checking AR support...");
    if (!navigator.xr) { setArError("WebXR not available. Use Chrome on Android or Safari on iOS 16+."); setInitStatus(""); return; }
    try {
      const ok = await navigator.xr.isSessionSupported("immersive-ar");
      if (!ok) { setArError("AR not supported on this device/browser."); setInitStatus(""); return; }
    } catch(e) { setArError("AR check failed: " + e.message); setInitStatus(""); return; }
    setInitStatus("Launching AR...");
    setStep("ar");
  }

  // ── INIT AR SESSION: called from useEffect, canvas is guaranteed mounted ──
  async function initARSession() {
    const THREE = window.THREE;
    const canvas = canvasRef.current;
    if (!canvas) { setArError("Canvas failed to mount. Reload and try again."); setStep("upload"); return; }
    setInitStatus("Initialising renderer...");
    try {
      if (rendererRef.current) { rendererRef.current.setAnimationLoop(null); rendererRef.current.dispose(); rendererRef.current = null; }
      const renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true, powerPreference:"high-performance" });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.xr.enabled = true;
      renderer.setClearColor(0x000000, 0);
      rendererRef.current = renderer;

      const scene = new THREE.Scene(); sceneRef.current = scene;
      scene.add(new THREE.AmbientLight(0xffffff, 0.8));
      const dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(1,2,3); scene.add(dl);

      const camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.01, 100);
      cameraRef.current = camera;

      // STL mesh
      const geo = geometryRef.current;
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const maxDim = Math.max(bb.max.x-bb.min.x, bb.max.y-bb.min.y, bb.max.z-bb.min.z);
      const worldScale = 0.3 / maxDim;

      const mesh = new THREE.LineSegments(
        new THREE.WireframeGeometry(geo),
        new THREE.LineBasicMaterial({ color:0x00ff00, linewidth:1.5 })
      );
      mesh.scale.setScalar(worldScale);
      mesh.visible = false;
      scene.add(mesh); meshRef.current = mesh;
      mesh.add(new THREE.AxesHelper(0.15));

      // Reticle
      const rGeo = new THREE.RingGeometry(0.08, 0.12, 32);
      rGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI/2));
      const reticle = new THREE.Mesh(rGeo, new THREE.MeshBasicMaterial({ color:0x00ff88, side:THREE.DoubleSide }));
      reticle.visible = false; scene.add(reticle); reticleMeshRef.current = reticle;

      setInitStatus("Requesting AR session...");
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures:["hit-test"],
        optionalFeatures:["dom-overlay","anchors"],
        domOverlay:{ root: document.getElementById("ar-overlay") }
      });
      xrSessionRef.current = session;
      setInitStatus("Setting up tracking...");
      renderer.xr.setReferenceSpaceType("local");
      await renderer.xr.setSession(session);
      const refSpace = await session.requestReferenceSpace("local"); xrRefSpaceRef.current = refSpace;
      const viewerSpace = await session.requestReferenceSpace("viewer");
      const hitSrc = await session.requestHitTestSource({ space: viewerSpace }); hitTestSrcRef.current = hitSrc;

      placedRef.current = false;
      setIsPlaced(false); setScanning(true); setHitAvailable(false);
      setLiveTransform({ x:0, y:0, z:0, rx:0, ry:0, rz:0, s:worldScale });
      setInitStatus("");

      // XR loop
      renderer.setAnimationLoop((ts, frame) => {
        if (!frame) return;
        const rsp = xrRefSpaceRef.current;
        const hs  = hitTestSrcRef.current;
        if (hs && !placedRef.current) {
          const hits = frame.getHitTestResults(hs);
          if (hits.length > 0) {
            const p = hits[0].getPose(rsp);
            if (p) {
              reticle.visible = true;
              reticle.matrix.fromArray(p.transform.matrix);
              reticle.matrixAutoUpdate = false;
              setHitAvailable(true); setScanning(false);
            }
          } else { reticle.visible = false; setHitAvailable(false); }
        }
        const vp = frame.getViewerPose(rsp);
        if (vp) {
          const v = vp.views[0];
          camera.projectionMatrix.fromArray(v.projectionMatrix);
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
          camera.matrix.fromArray(v.transform.matrix);
          camera.matrixWorldNeedsUpdate = true;
        }
        renderer.render(scene, camera);
      });

      session.addEventListener("end", () => { cleanupAR(); setStep("upload"); setToast({ message:"AR session ended", type:"info" }); });
    } catch(err) {
      console.error("WebXR error:", err);
      setArError(
        err.name==="NotSupportedError" ? "AR not supported on this device." :
        err.name==="SecurityError"     ? "HTTPS required. You're on netlify.app ✓ — try reloading." :
        err.name==="NotAllowedError"   ? "Camera permission denied. Tap Allow when prompted." :
        err.name==="InvalidStateError" ? "AR session conflict. Reload the page." :
        "AR failed: " + err.message
      );
      setInitStatus(""); cleanupAR(); setStep("upload");
    }
  }

  function placeModel() {
    const reticle = reticleMeshRef.current;
    const mesh    = meshRef.current;
    if (!reticle || !reticle.visible || !mesh) return;
    const THREE = window.THREE;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    reticle.matrix.decompose(pos, quat, scl);
    mesh.position.copy(pos);
    mesh.quaternion.copy(quat);
    mesh.visible = true;
    reticle.visible = false;
    placedRef.current = true;
    setIsPlaced(true); setHitAvailable(false);
    setLiveTransform(t => ({ ...t, x:pos.x, y:pos.y, z:pos.z }));
    setToast({ message:"✅ Model placed! Use controls below to transform.", type:"success" });
  }

  function repositionModel() {
    const mesh = meshRef.current; const reticle = reticleMeshRef.current;
    if (mesh) mesh.visible = false;
    if (reticle) reticle.visible = false;
    placedRef.current = false;
    setIsPlaced(false); setScanning(true); setHitAvailable(false);
    setToast({ message:"Move camera over a flat surface", type:"info" });
  }

  function resetTransform() {
    const mesh = meshRef.current; if (!mesh) return;
    mesh.rotation.set(0, 0, 0);
    const geo = geometryRef.current;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const maxDim = Math.max(bb.max.x-bb.min.x, bb.max.y-bb.min.y, bb.max.z-bb.min.z);
    const worldScale = 0.3 / maxDim;
    mesh.scale.setScalar(worldScale);
    setLiveTransform(t => ({ ...t, rx:0, ry:0, rz:0, s:worldScale }));
    setToast({ message:"Transform reset", type:"info" });
  }

  // ── GESTURE HANDLER ──
  useEffect(() => {
    if (step !== "ar") return;
    const el = gestureLayerRef.current; if (!el) return;

    function getTwoFingerData(e) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
      return { dist: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
    }

    const onTS = (e) => {
      if (e.touches.length >= 1) touch1Ref.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.touches.length >= 2) {
        touch2Ref.current = { x: e.touches[1].clientX, y: e.touches[1].clientY };
        const { dist, angle } = getTwoFingerData(e);
        lastPinchDistRef.current = dist;
        lastTwoAngleRef.current  = angle;
      }
    };

    const onTM = (e) => {
      e.preventDefault();
      const mesh = meshRef.current;
      if (!mesh || !placedRef.current) return;

      const mode = activeModeRef.current;

      // ── PINCH = SCALE (works in all modes) ──
      if (e.touches.length >= 2) {
        const { dist, angle } = getTwoFingerData(e);

        // Scale via pinch
        if (lastPinchDistRef.current) {
          const ratio = dist / lastPinchDistRef.current;
          const ns = mesh.scale.x * ratio;
          if (ns > 0.001 && ns < 20) {
            mesh.scale.setScalar(ns);
            setLiveTransform(t => ({ ...t, s: ns }));
          }
        }

        // Two-finger rotate X/Z (in rotate mode)
        if (mode === "rotate" && lastTwoAngleRef.current !== null) {
          const dAngle = angle - lastTwoAngleRef.current;
          mesh.rotation.x += dAngle;
          setLiveTransform(t => ({ ...t, rx: mesh.rotation.x }));
        }

        lastPinchDistRef.current = dist;
        lastTwoAngleRef.current  = angle;
        touch2Ref.current = { x: e.touches[1].clientX, y: e.touches[1].clientY };

      } else if (e.touches.length === 1 && touch1Ref.current) {
        // ── SINGLE FINGER ──
        const dx = e.touches[0].clientX - touch1Ref.current.x;
        const dy = e.touches[0].clientY - touch1Ref.current.y;
        touch1Ref.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };

        const cam = cameraRef.current;

        if (mode === "move") {
          // Move on XZ plane relative to camera look direction
          if (cam) {
            // Get camera forward direction projected onto XZ plane
            const THREE = window.THREE;
            const camDir = new THREE.Vector3();
            cam.getWorldDirection(camDir);
            camDir.y = 0; camDir.normalize();
            const right = new THREE.Vector3();
            right.crossVectors(new THREE.Vector3(0,1,0), camDir).normalize();

            const speed = 0.003;
            mesh.position.addScaledVector(right,   -dx * speed);
            mesh.position.addScaledVector(camDir,  -dy * speed);
            setLiveTransform(t => ({ ...t, x: +mesh.position.x.toFixed(3), z: +mesh.position.z.toFixed(3) }));
          }

        } else if (mode === "rotate") {
          // Drag left/right = rotate Y, drag up/down = rotate Z
          mesh.rotation.y += dx * 0.01;
          mesh.rotation.z -= dy * 0.01;
          setLiveTransform(t => ({ ...t, ry: mesh.rotation.y, rz: mesh.rotation.z }));

        } else if (mode === "elevate") {
          // Move up/down on Y axis
          const speed = 0.003;
          mesh.position.y -= dy * speed;
          setLiveTransform(t => ({ ...t, y: +mesh.position.y.toFixed(3) }));

        } else if (mode === "scale") {
          // Single-finger up/down also scales (alternative to pinch)
          const ratio = dy < 0 ? 1 + Math.abs(dy)*0.005 : 1 - Math.abs(dy)*0.005;
          const ns = Math.max(0.001, Math.min(20, mesh.scale.x * ratio));
          mesh.scale.setScalar(ns);
          setLiveTransform(t => ({ ...t, s: ns }));
        }
      }
    };

    const onTE = (e) => {
      if (e.touches.length < 2) { lastPinchDistRef.current = null; lastTwoAngleRef.current = null; touch2Ref.current = null; }
      if (e.touches.length < 1) { touch1Ref.current = null; }
    };

    el.addEventListener("touchstart", onTS, { passive:false });
    el.addEventListener("touchmove",  onTM, { passive:false });
    el.addEventListener("touchend",   onTE);
    el.addEventListener("touchcancel",onTE);
    return () => {
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchmove",  onTM);
      el.removeEventListener("touchend",   onTE);
      el.removeEventListener("touchcancel",onTE);
    };
  }, [step]);

  function cleanupAR() {
    if (rendererRef.current) { rendererRef.current.setAnimationLoop(null); rendererRef.current.dispose(); rendererRef.current = null; }
    if (hitTestSrcRef.current) { try { hitTestSrcRef.current.cancel(); } catch{} hitTestSrcRef.current = null; }
    if (xrSessionRef.current)  { try { xrSessionRef.current.end(); }    catch{} xrSessionRef.current  = null; }
    xrRefSpaceRef.current = null; meshRef.current = null; reticleMeshRef.current = null;
    sceneRef.current = null; cameraRef.current = null;
  }

  const onDrop = (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); };

  // ══════════════════════════════════════════
  // UPLOAD SCREEN
  // ══════════════════════════════════════════
  if (step === "upload") return (
    <div style={{ minHeight:"100vh", background:"#080c08", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px 16px", fontFamily:"'JetBrains Mono','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&display=swap');
        @keyframes toastIn  { from{opacity:0;transform:translate(-50%,-12px) scale(0.9)} to{opacity:1;transform:translate(-50%,0) scale(1)} }
        @keyframes scanRing { 0%{transform:scale(0.4);opacity:0.8} 100%{transform:scale(2);opacity:0} }
        @keyframes spin     { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        @keyframes fadeUp   { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes gridPulse{ 0%,100%{opacity:0.03} 50%{opacity:0.07} }
        .dz:hover  { border-color:#00ff88!important; background:rgba(0,255,136,0.04)!important; }
        .dz:hover .dz-icon { color:#00ff88!important; transform:scale(1.1); }
        .btn-ar { transition:all 0.2s; }
        .btn-ar:hover  { background:#00cc6a!important; transform:translateY(-1px); }
        .btn-ar:active { transform:scale(0.97); }
      `}</style>
      <div style={{ position:"fixed", inset:0, zIndex:0, pointerEvents:"none", backgroundImage:"linear-gradient(rgba(0,255,136,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,136,0.05) 1px,transparent 1px)", backgroundSize:"40px 40px", animation:"gridPulse 4s ease-in-out infinite" }} />
      {toast && <Toast {...toast} onDone={() => setToast(null)} />}
      <div style={{ position:"relative", zIndex:1, width:"100%", maxWidth:460, animation:"fadeUp 0.5s ease" }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ fontSize:10, letterSpacing:6, color:"#00ff8877", marginBottom:10 }}>WEBXR · ARCORE · ARKIT</div>
          <h1 style={{ fontSize:24, color:"#fff", margin:0, fontWeight:300, letterSpacing:4 }}>
            CAD <span style={{ color:"#00ff88", fontWeight:700 }}>OVERLAY</span>
          </h1>
          <p style={{ color:"#334433", fontSize:10, marginTop:8, letterSpacing:2 }}>REAL-WORLD AR · FULL TRANSFORM</p>
        </div>

        <div className="dz" onDrop={onDrop} onDragOver={e=>e.preventDefault()}
          onClick={() => document.getElementById("stl-input").click()}
          style={{ border:"1px dashed #1a321a", borderRadius:16, padding:"28px 20px", textAlign:"center", cursor:"pointer", background:"#0a120a", transition:"all 0.25s", marginBottom:14 }}>
          <input id="stl-input" type="file" accept=".stl" style={{ display:"none" }} onChange={e=>handleFile(e.target.files[0])} />
          {!parseInfo ? (
            <>
              <div className="dz-icon" style={{ fontSize:44, color:"#1e3e1e", marginBottom:14, transition:"all 0.2s" }}>⬡</div>
              <div style={{ color:"#3a5a3a", fontSize:12, lineHeight:2, letterSpacing:1 }}>
                DROP <span style={{ color:"#00ff88" }}>.STL</span> HERE<br/>
                <span style={{ color:"#243424", fontSize:10 }}>or tap to browse</span>
              </div>
              {!threeReady && <div style={{ marginTop:14, fontSize:10, color:"#3a5a3a", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}><span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span> LOADING 3D ENGINE</div>}
            </>
          ) : (
            <div onClick={e=>e.stopPropagation()}>
              <canvas ref={previewCanvasRef} width={280} height={280} style={{ borderRadius:10, display:"block", margin:"0 auto 14px" }} />
              <div style={{ color:"#fff", fontSize:12, marginBottom:4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{parseInfo.name}</div>
              <div style={{ color:"#00ff88", fontSize:11, lineHeight:2 }}>{parseInfo.tris.toLocaleString()} triangles</div>
              <div style={{ color:"#334433", fontSize:10 }}>{parseInfo.w} × {parseInfo.h} × {parseInfo.d} mm</div>
              <div style={{ marginTop:10, fontSize:9, color:"#1e2e1e", borderTop:"1px solid #142014", paddingTop:10 }}>TAP TO REPLACE</div>
            </div>
          )}
          {parseError && <div style={{ marginTop:10, color:"#ff6644", fontSize:11 }}>{parseError}</div>}
        </div>

        <div style={{ textAlign:"center", marginBottom:14, minHeight:32 }}>
          {xrSupported === null && <div style={{ color:"#334433", fontSize:10, letterSpacing:1 }}><span style={{ animation:"spin 1s linear infinite", display:"inline-block", marginRight:6 }}>◌</span>CHECKING AR SUPPORT</div>}
          {xrSupported === true  && <div style={{ color:"#00ff88", fontSize:10, letterSpacing:1 }}>✓ AR SUPPORTED ON THIS DEVICE</div>}
          {xrSupported === false && <div style={{ color:"#ff6644", fontSize:10, letterSpacing:1, lineHeight:2 }}>⚠ WebXR AR not detected<br/><span style={{ color:"#334433", fontSize:9 }}>Android: Chrome 81+ | iOS: Safari 16+ | Must be HTTPS ✓</span></div>}
        </div>

        {parseInfo && (
          <button className="btn-ar" onClick={startAR} disabled={xrSupported===false} style={{
            width:"100%", padding:"16px", borderRadius:10,
            background: xrSupported===false ? "#111a11" : "#00ff88",
            color: xrSupported===false ? "#334433" : "#000",
            border:"none", fontSize:13, fontWeight:700,
            cursor: xrSupported===false ? "not-allowed" : "pointer",
            letterSpacing:3, fontFamily:"'JetBrains Mono',monospace",
            boxShadow: xrSupported!==false ? "0 4px 20px rgba(0,255,136,0.25)" : "none"
          }}>
            {initStatus || (xrSupported===false ? "AR NOT AVAILABLE" : "▶  LAUNCH AR")}
          </button>
        )}

        {arError && (
          <div style={{ marginTop:14, background:"#120808", border:"1px solid #ff444433", borderRadius:10, padding:"14px 16px", color:"#ff6644", fontSize:11, lineHeight:1.9 }}>
            <div style={{ fontWeight:700, marginBottom:4 }}>⚠ {arError}</div>
            {arError.includes("permission") && <div style={{ color:"#334433", fontSize:10 }}>Settings → Site permissions → Camera → Allow</div>}
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginTop:20, flexWrap:"wrap", justifyContent:"center" }}>
          {["ARCore / ARKit","6DoF Tracking","Full Transform","No OpenCV"].map(t => (
            <div key={t} style={{ padding:"4px 10px", borderRadius:20, border:"1px solid #1a2e1a", color:"#3a5a3a", fontSize:9, letterSpacing:1 }}>{t}</div>
          ))}
        </div>
      </div>
    </div>
  );

  // ══════════════════════════════════════════
  // AR SCREEN
  // ══════════════════════════════════════════
  const toDeg = (r) => (r * 180/Math.PI).toFixed(0);

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
        @keyframes pulse    { 0%,100%{box-shadow:0 0 0 0 rgba(0,255,136,0.4)} 50%{box-shadow:0 0 0 8px rgba(0,255,136,0)} }
        .mode-btn { transition:all 0.15s; }
        .mode-btn:active { transform:scale(0.92); }
        .ctrl-btn { transition:all 0.15s; }
        .ctrl-btn:active { transform:scale(0.93); }
      `}</style>

      {toast && <Toast {...toast} onDone={() => setToast(null)} />}

      {/* WebXR Canvas */}
      <canvas ref={canvasRef} style={{ position:"absolute", inset:0, width:"100%", height:"100%" }} />

      {/* DOM Overlay */}
      <div id="ar-overlay" style={{ position:"absolute", inset:0, pointerEvents:"none" }}>

        {/* Gesture layer — active only when placed */}
        <div ref={gestureLayerRef} style={{
          position:"absolute", inset:0,
          pointerEvents: isPlaced ? "auto" : "none",
          touchAction:"none"
        }} />

        {/* ── TOP BAR ── */}
        <div style={{
          position:"absolute", top:0, left:0, right:0,
          background:"rgba(0,0,0,0.65)", backdropFilter:"blur(12px)",
          padding:"10px 14px", display:"flex", alignItems:"center",
          justifyContent:"space-between", pointerEvents:"auto",
          borderBottom:"1px solid rgba(0,255,136,0.08)"
        }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:"#00ff88", letterSpacing:4 }}>CAD·AR</div>

          {/* Live transform readout */}
          <div style={{ display:"flex", gap:8, fontFamily:"'JetBrains Mono',monospace", fontSize:9, color:"#00ff8899", flexWrap:"wrap", justifyContent:"center" }}>
            {[
              ["X", liveTransform.x.toFixed ? liveTransform.x.toFixed(2) : "0"],
              ["Y", liveTransform.y.toFixed ? liveTransform.y.toFixed(2) : "0"],
              ["Z", liveTransform.z.toFixed ? liveTransform.z.toFixed(2) : "0"],
              ["Rx", toDeg(liveTransform.rx)+"°"],
              ["Ry", toDeg(liveTransform.ry)+"°"],
              ["Rz", toDeg(liveTransform.rz)+"°"],
              ["S", (liveTransform.s||1).toFixed(2)],
            ].map(([k,v]) => (
              <span key={k}><span style={{ color:"#223322" }}>{k}:</span>{v}</span>
            ))}
          </div>

          <button className="ctrl-btn" onClick={() => { cleanupAR(); setStep("upload"); setIsPlaced(false); setScanning(true); setArError(null); }}
            style={{ background:"rgba(0,0,0,0.5)", border:"1px solid #1a2a1a", color:"#446644", padding:"6px 12px", borderRadius:6, fontSize:10, fontFamily:"'JetBrains Mono',monospace", cursor:"pointer", letterSpacing:1, pointerEvents:"auto" }}>
            ← EXIT
          </button>
        </div>

        {/* ── INIT STATUS ── */}
        {initStatus !== "" && (
          <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", textAlign:"center", pointerEvents:"none" }}>
            <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:"#00ff88", letterSpacing:2, display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>◌</span>
              {initStatus}
            </div>
          </div>
        )}

        {/* ── SCANNING GUIDE ── */}
        {!isPlaced && initStatus==="" && (
          <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", textAlign:"center", pointerEvents:"none", animation:"fadeIn 0.5s ease" }}>
            {scanning && (
              <>
                <ScanRing />
                <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:"#00ff88", letterSpacing:3, animation:"blink 1.5s ease-in-out infinite" }}>SCANNING SURFACE</div>
                <div style={{ color:"#334433", fontSize:9, marginTop:8, letterSpacing:1 }}>Move camera slowly over a flat surface</div>
              </>
            )}
            {!scanning && hitAvailable && (
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:12, color:"#00ff88", letterSpacing:2 }}>✦ SURFACE DETECTED</div>
            )}
          </div>
        )}

        {/* ── PLACE BUTTON ── */}
        {!isPlaced && hitAvailable && initStatus==="" && (
          <div style={{ position:"absolute", bottom:140, left:"50%", transform:"translateX(-50%)", pointerEvents:"auto", animation:"slideUp 0.4s cubic-bezier(0.34,1.56,0.64,1)" }}>
            <button onClick={placeModel} style={{
              padding:"18px 52px", borderRadius:50, background:"#00ff88", color:"#000",
              border:"none", fontSize:14, fontWeight:700, cursor:"pointer",
              letterSpacing:3, fontFamily:"'JetBrains Mono',monospace",
              boxShadow:"0 8px 32px rgba(0,255,136,0.45)", animation:"pulse 2s infinite"
            }}>
              ⊕ PLACE MODEL
            </button>
          </div>
        )}

        {/* ════════════════════════════════════════
            POST-PLACEMENT CONTROLS
            ════════════════════════════════════════ */}
        {isPlaced && (
          <>
            {/* Placed badge */}
            <div style={{
              position:"absolute", top:58, left:"50%", transform:"translateX(-50%)",
              background:"rgba(0,255,136,0.08)", border:"1px solid #00ff8822",
              borderRadius:20, padding:"4px 16px",
              fontFamily:"'JetBrains Mono',monospace", fontSize:9,
              color:"#00ff88", letterSpacing:2, pointerEvents:"none"
            }}>● MODEL PLACED</div>

            {/* ── MODE SELECTOR — horizontal pill row ── */}
            <div style={{
              position:"absolute", bottom:170, left:"50%", transform:"translateX(-50%)",
              display:"flex", gap:8, pointerEvents:"auto",
              animation:"slideUp 0.3s ease"
            }}>
              {MODES.map(m => (
                <button key={m.id} className="mode-btn"
                  onClick={() => { setActiveMode(m.id); setToast({ message: m.hint, type:"info" }); }}
                  style={{
                    display:"flex", flexDirection:"column", alignItems:"center", gap:4,
                    padding:"10px 14px", borderRadius:12,
                    background: activeMode===m.id ? "rgba(0,255,136,0.2)" : "rgba(0,0,0,0.65)",
                    border: `1px solid ${activeMode===m.id ? "#00ff88" : "#1a2a1a"}`,
                    color: activeMode===m.id ? "#00ff88" : "#446644",
                    cursor:"pointer", fontFamily:"'JetBrains Mono',monospace",
                    boxShadow: activeMode===m.id ? "0 0 12px rgba(0,255,136,0.25)" : "none",
                    backdropFilter:"blur(10px)", minWidth:58
                  }}>
                  <span style={{ fontSize:18, lineHeight:1 }}>{m.icon}</span>
                  <span style={{ fontSize:8, letterSpacing:1 }}>{m.label.toUpperCase()}</span>
                </button>
              ))}
            </div>

            {/* ── GESTURE HINT for active mode ── */}
            <div style={{
              position:"absolute", bottom:148, left:"50%", transform:"translateX(-50%)",
              pointerEvents:"none"
            }}>
              <div style={{
                background:"rgba(0,0,0,0.6)", backdropFilter:"blur(8px)",
                borderRadius:8, padding:"5px 14px",
                fontFamily:"'JetBrains Mono',monospace", fontSize:9,
                color:"#446644", letterSpacing:1, whiteSpace:"nowrap"
              }}>
                {MODES.find(m=>m.id===activeMode)?.hint}
                {activeMode !== "scale" && " · Pinch=Scale"}
              </div>
            </div>

            {/* ── BOTTOM ACTION ROW ── */}
            <div style={{
              position:"absolute", bottom:24, left:"50%", transform:"translateX(-50%)",
              display:"flex", gap:10, pointerEvents:"auto",
              animation:"slideUp 0.4s ease"
            }}>
              {/* Reposition */}
              <button className="ctrl-btn" onClick={repositionModel} style={{
                padding:"12px 18px", borderRadius:10,
                background:"rgba(0,0,0,0.7)", border:"1px solid #1a2a1a",
                color:"#446644", fontSize:10, fontFamily:"'JetBrains Mono',monospace",
                cursor:"pointer", letterSpacing:1, backdropFilter:"blur(8px)"
              }}>↺ REPOSITION</button>

              {/* Reset rotation/scale */}
              <button className="ctrl-btn" onClick={resetTransform} style={{
                padding:"12px 18px", borderRadius:10,
                background:"rgba(0,0,0,0.7)", border:"1px solid #1a2a1a",
                color:"#446644", fontSize:10, fontFamily:"'JetBrains Mono',monospace",
                cursor:"pointer", letterSpacing:1, backdropFilter:"blur(8px)"
              }}>⟳ RESET</button>

              {/* Mirror X */}
              <button className="ctrl-btn" onClick={() => {
                const m = meshRef.current; if (!m) return;
                m.scale.x *= -1;
                setToast({ message:"Mirrored on X axis", type:"info" });
              }} style={{
                padding:"12px 18px", borderRadius:10,
                background:"rgba(0,0,0,0.7)", border:"1px solid #1a2a1a",
                color:"#446644", fontSize:10, fontFamily:"'JetBrains Mono',monospace",
                cursor:"pointer", letterSpacing:1, backdropFilter:"blur(8px)"
              }}>⟺ MIRROR</button>
            </div>

            {/* ── FINE ROTATE BUTTONS (right side) ── */}
            {activeMode === "rotate" && (
              <div style={{
                position:"absolute", right:16, top:"50%", transform:"translateY(-50%)",
                display:"flex", flexDirection:"column", gap:8,
                pointerEvents:"auto", animation:"fadeIn 0.3s ease"
              }}>
                {[
                  { label:"Rx+", fn: () => { const m=meshRef.current; if(m){m.rotation.x+=Math.PI/12; setLiveTransform(t=>({...t,rx:m.rotation.x}));} } },
                  { label:"Rx−", fn: () => { const m=meshRef.current; if(m){m.rotation.x-=Math.PI/12; setLiveTransform(t=>({...t,rx:m.rotation.x}));} } },
                  { label:"Ry+", fn: () => { const m=meshRef.current; if(m){m.rotation.y+=Math.PI/12; setLiveTransform(t=>({...t,ry:m.rotation.y}));} } },
                  { label:"Ry−", fn: () => { const m=meshRef.current; if(m){m.rotation.y-=Math.PI/12; setLiveTransform(t=>({...t,ry:m.rotation.y}));} } },
                  { label:"Rz+", fn: () => { const m=meshRef.current; if(m){m.rotation.z+=Math.PI/12; setLiveTransform(t=>({...t,rz:m.rotation.z}));} } },
                  { label:"Rz−", fn: () => { const m=meshRef.current; if(m){m.rotation.z-=Math.PI/12; setLiveTransform(t=>({...t,rz:m.rotation.z}));} } },
                ].map(({label,fn}) => (
                  <button key={label} className="ctrl-btn" onClick={fn} style={{
                    padding:"10px 10px", borderRadius:8, minWidth:48,
                    background:"rgba(0,0,0,0.7)", border:"1px solid #1a3a1a",
                    color:"#00ff8899", fontSize:9, fontFamily:"'JetBrains Mono',monospace",
                    cursor:"pointer", letterSpacing:0.5, backdropFilter:"blur(8px)",
                    textAlign:"center"
                  }}>{label}</button>
                ))}
              </div>
            )}

            {/* ── FINE SCALE BUTTONS (right side, scale mode) ── */}
            {activeMode === "scale" && (
              <div style={{
                position:"absolute", right:16, top:"50%", transform:"translateY(-50%)",
                display:"flex", flexDirection:"column", gap:8,
                pointerEvents:"auto", animation:"fadeIn 0.3s ease"
              }}>
                {[
                  { label:"2×",   fn: () => { const m=meshRef.current; if(m){const ns=m.scale.x*2; m.scale.setScalar(ns); setLiveTransform(t=>({...t,s:ns}));} } },
                  { label:"+10%", fn: () => { const m=meshRef.current; if(m){const ns=m.scale.x*1.1; m.scale.setScalar(ns); setLiveTransform(t=>({...t,s:ns}));} } },
                  { label:"+5%",  fn: () => { const m=meshRef.current; if(m){const ns=m.scale.x*1.05; m.scale.setScalar(ns); setLiveTransform(t=>({...t,s:ns}));} } },
                  { label:"−5%",  fn: () => { const m=meshRef.current; if(m){const ns=m.scale.x*0.95; m.scale.setScalar(ns); setLiveTransform(t=>({...t,s:ns}));} } },
                  { label:"−10%", fn: () => { const m=meshRef.current; if(m){const ns=m.scale.x*0.9; m.scale.setScalar(ns); setLiveTransform(t=>({...t,s:ns}));} } },
                  { label:"½×",   fn: () => { const m=meshRef.current; if(m){const ns=m.scale.x*0.5; m.scale.setScalar(ns); setLiveTransform(t=>({...t,s:ns}));} } },
                ].map(({label,fn}) => (
                  <button key={label} className="ctrl-btn" onClick={fn} style={{
                    padding:"10px 10px", borderRadius:8, minWidth:48,
                    background:"rgba(0,0,0,0.7)", border:"1px solid #1a3a1a",
                    color:"#00ff8899", fontSize:9, fontFamily:"'JetBrains Mono',monospace",
                    cursor:"pointer", letterSpacing:0.5, backdropFilter:"blur(8px)",
                    textAlign:"center"
                  }}>{label}</button>
                ))}
              </div>
            )}

            {/* ── ELEVATE BUTTONS (right side, elevate mode) ── */}
            {activeMode === "elevate" && (
              <div style={{
                position:"absolute", right:16, top:"50%", transform:"translateY(-50%)",
                display:"flex", flexDirection:"column", gap:8,
                pointerEvents:"auto", animation:"fadeIn 0.3s ease"
              }}>
                {[
                  { label:"↑↑",  fn: () => { const m=meshRef.current; if(m){m.position.y+=0.05; setLiveTransform(t=>({...t,y:+m.position.y.toFixed(3)}));} } },
                  { label:"↑",   fn: () => { const m=meshRef.current; if(m){m.position.y+=0.01; setLiveTransform(t=>({...t,y:+m.position.y.toFixed(3)}));} } },
                  { label:"↓",   fn: () => { const m=meshRef.current; if(m){m.position.y-=0.01; setLiveTransform(t=>({...t,y:+m.position.y.toFixed(3)}));} } },
                  { label:"↓↓",  fn: () => { const m=meshRef.current; if(m){m.position.y-=0.05; setLiveTransform(t=>({...t,y:+m.position.y.toFixed(3)}));} } },
                ].map(({label,fn}) => (
                  <button key={label} className="ctrl-btn" onClick={fn} style={{
                    padding:"12px 12px", borderRadius:8, minWidth:48,
                    background:"rgba(0,0,0,0.7)", border:"1px solid #1a3a1a",
                    color:"#00ff8899", fontSize:14, fontFamily:"'JetBrains Mono',monospace",
                    cursor:"pointer", backdropFilter:"blur(8px)", textAlign:"center"
                  }}>{label}</button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── FOV TUNER ── */}
        <div style={{ position:"absolute", top:64, right:16, pointerEvents:"auto" }}>
          <button onClick={() => setShowFov(s=>!s)} style={{
            background:"rgba(0,0,0,0.65)", border:"1px solid #1a2a1a",
            color:"#3a5a3a", padding:"6px 12px", borderRadius:6,
            fontSize:9, fontFamily:"'JetBrains Mono',monospace", cursor:"pointer", letterSpacing:1
          }}>⊙ FOV</button>
          {showFov && (
            <div style={{ marginTop:8, background:"rgba(0,0,0,0.88)", border:"1px solid #1a2a1a", borderRadius:10, padding:"14px 16px", minWidth:160, animation:"fadeIn 0.2s ease" }}>
              <div style={{ color:"#00ff88", fontSize:9, letterSpacing:2, marginBottom:10, fontFamily:"'JetBrains Mono',monospace" }}>FOV: {fov}°</div>
              <input type="range" min={40} max={110} value={fov} step={1}
                onChange={e => {
                  const v = parseInt(e.target.value); setFov(v);
                  if (cameraRef.current) { cameraRef.current.fov=v; cameraRef.current.updateProjectionMatrix(); }
                }}
                style={{ width:"100%", accentColor:"#00ff88" }} />
              <div style={{ color:"#223322", fontSize:8, marginTop:6, fontFamily:"'JetBrains Mono',monospace", display:"flex", justifyContent:"space-between" }}>
                <span>40° NARROW</span><span>110° WIDE</span>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
