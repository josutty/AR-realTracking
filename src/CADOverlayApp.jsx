// ── CAD OVERLAY APP ──
// Single-file React app: STL upload → camera overlay → manual alignment → ORB tracking

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
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  const bg = type === "success" ? "#00ff88" : type === "warn" ? "#ffcc00" : "#ff4444";
  const tx = type === "success" || type === "warn" ? "#000" : "#fff";
  return (
    <div style={{
      position:"fixed",top:80,left:"50%",transform:"translateX(-50%)",
      background:bg,color:tx,padding:"10px 20px",borderRadius:8,
      fontFamily:"monospace",fontWeight:700,fontSize:13,zIndex:9999,
      boxShadow:`0 0 20px ${bg}88`,letterSpacing:0.5,
      animation:"fadeInDown 0.3s ease"
    }}>{message}</div>
  );
}

export default function CADOverlayApp() {
  const [step, setStep] = useState("upload");
  const [threeReady, setThreeReady] = useState(false);
  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState(false);
  const [parseInfo, setParseInfo] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [camError, setCamError] = useState(null);
  const [trackingState, setTrackingState] = useState("idle");
  const [matchCount, setMatchCount] = useState(0);
  const [toast, setToast] = useState(null);
  const [transform, setTransform] = useState({ x:0, y:0, scale:1, rotX:0, rotY:0, rotZ:0 });

  const previewCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const videoRef = useRef(null);
  const gestureRef = useRef(null);
  const rendererPreviewRef = useRef(null);
  const rendererOverlayRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const meshRef = useRef(null);
  const geometryRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const previewAnimRef = useRef(null);
  const transformRef = useRef({ x:0, y:0, scale:1, rotX:0, rotY:0, rotZ:0 });
  const refDataRef = useRef(null);
  const orbRef = useRef(null);
  const isDraggingRef = useRef(false);
  const lastPointerRef = useRef({ x:0, y:0 });
  const lastPinchRef = useRef(null);
  const lastTwoFingerAngleRef = useRef(null);
  const rightClickRef = useRef(false);
  const shiftRef = useRef(false);
  const ctrlRef = useRef(false);

  // ── LOAD SCRIPTS ──
  useEffect(() => {
    async function loadLibs() {
      try {
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js");
        await loadScript("https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js");
        setThreeReady(true);
      } catch(e) { console.error("Three.js load failed", e); }
      try {
        await loadScript("https://docs.opencv.org/4.8.0/opencv.js");
        await new Promise(res => { const c = () => { if(window.cv && window.cv.Mat) res(); else setTimeout(c,100); }; c(); });
        setCvReady(true);
      } catch { setCvError(true); }
    }
    loadLibs();
    return () => cleanupAll();
  }, []);

  // ── STL PARSE ──
  const handleFileSelect = useCallback((file) => {
    if (!file || !file.name.toLowerCase().endsWith(".stl")) { setParseError("Only .stl files accepted."); return; }
    if (!threeReady) { setParseError("3D engine loading, please wait..."); return; }
    setParseError(null); setParseInfo(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const THREE = window.THREE;
        const loader = new THREE.STLLoader();
        const geometry = loader.parse(e.target.result);
        geometry.computeBoundingBox(); geometry.center();
        const bb = geometry.boundingBox;
        const w = (bb.max.x - bb.min.x).toFixed(1);
        const h = (bb.max.y - bb.min.y).toFixed(1);
        const d = (bb.max.z - bb.min.z).toFixed(1);
        const triangles = Math.round(geometry.attributes.position.count / 3);
        geometryRef.current = geometry;
        setParseInfo({ name: file.name, triangles, w, h, d });
        setTimeout(() => initPreview(geometry), 50);
      } catch { setParseError("Failed to parse STL. Is it a valid binary or ASCII STL?"); }
    };
    reader.readAsArrayBuffer(file);
  }, [threeReady]);

  function initPreview(geometry) {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const THREE = window.THREE;
    if (rendererPreviewRef.current) { rendererPreviewRef.current.dispose(); cancelAnimationFrame(previewAnimRef.current); }
    const renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true });
    renderer.setSize(300,300); renderer.setClearColor(0x000000,0);
    rendererPreviewRef.current = renderer;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45,1,0.01,1000);
    const sphere = new THREE.Sphere();
    new THREE.Box3().setFromObject(new THREE.Mesh(geometry)).getBoundingSphere(sphere);
    camera.position.set(0,0,sphere.radius*2.5);
    const mesh = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial({ color:0x00ff88 }));
    scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff,1));
    const animate = () => { previewAnimRef.current = requestAnimationFrame(animate); mesh.rotation.y += 0.01; renderer.render(scene,camera); };
    animate();
  }

  // ── CAMERA ──
  async function startCamera() {
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video:{ facingMode:"environment", width:{ideal:1280}, height:{ideal:720} }, audio:false
      });
      streamRef.current = stream;
      setStep("camera");
      setTimeout(() => initCameraOverlay(stream), 100);
    } catch(err) {
      setCamError(err.name === "NotAllowedError"
        ? "Camera permission denied. Allow camera access in browser settings and reload."
        : "Could not access camera: " + err.message);
    }
  }

  function initCameraOverlay(stream) {
    const THREE = window.THREE;
    const video = videoRef.current;
    const canvas = overlayCanvasRef.current;
    if (!video || !canvas) return;
    video.srcObject = stream; video.play();
    const W = window.innerWidth, H = window.innerHeight;
    if (rendererOverlayRef.current) rendererOverlayRef.current.dispose();
    const renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true });
    renderer.setSize(W,H); renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000,0);
    rendererOverlayRef.current = renderer;
    const scene = new THREE.Scene(); sceneRef.current = scene;
    const cam = new THREE.PerspectiveCamera(45,W/H,0.01,1000);
    cam.position.set(0,0,5); cameraRef.current = cam;
    const geometry = geometryRef.current;
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = Math.max(bb.max.x-bb.min.x, bb.max.y-bb.min.y, bb.max.z-bb.min.z);
    const targetScale = (H * 0.3) / (size * 100);
    const mesh = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color:0x00ff00, linewidth:1.5 })
    );
    mesh.scale.setScalar(targetScale);
    scene.add(mesh); meshRef.current = mesh;
    scene.add(new THREE.AxesHelper(0.5));
    scene.add(new THREE.AmbientLight(0xffffff,1));
    transformRef.current = { x:0, y:0, scale:targetScale, rotX:0, rotY:0, rotZ:0 };
    setTransform({ ...transformRef.current });
    cancelAnimationFrame(animFrameRef.current);
    const loop = () => { animFrameRef.current = requestAnimationFrame(loop); renderer.render(scene,cam); };
    loop();
    const onResize = () => {
      const w=window.innerWidth, h=window.innerHeight;
      renderer.setSize(w,h); cam.aspect=w/h; cam.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);
  }

  // ── GESTURES ──
  useEffect(() => {
    if (step !== "camera" && step !== "tracking") return;
    const el = gestureRef.current;
    if (!el) return;
    const onPD = (e) => {
      if (e.button === 2) { rightClickRef.current=true; shiftRef.current=e.shiftKey; ctrlRef.current=e.ctrlKey; lastPointerRef.current={x:e.clientX,y:e.clientY}; return; }
      isDraggingRef.current=true; lastPointerRef.current={x:e.clientX,y:e.clientY};
    };
    const onPM = (e) => {
      const dx=e.clientX-lastPointerRef.current.x, dy=e.clientY-lastPointerRef.current.y;
      lastPointerRef.current={x:e.clientX,y:e.clientY};
      const mesh=meshRef.current; if(!mesh) return;
      if (rightClickRef.current) {
        const s=0.005;
        if (shiftRef.current) mesh.rotation.x+=dy*s;
        else if (ctrlRef.current) mesh.rotation.z+=dx*s;
        else mesh.rotation.y+=dx*s;
        transformRef.current.rotX=mesh.rotation.x; transformRef.current.rotY=mesh.rotation.y; transformRef.current.rotZ=mesh.rotation.z;
        setTransform({...transformRef.current}); return;
      }
      if (isDraggingRef.current) {
        const cam=cameraRef.current;
        const f=(2*Math.tan((cam.fov*Math.PI/180)/2)*cam.position.z)/window.innerHeight;
        mesh.position.x+=dx*f; mesh.position.y-=dy*f;
        transformRef.current.x=mesh.position.x; transformRef.current.y=mesh.position.y;
        setTransform({...transformRef.current});
      }
    };
    const onPU = () => { isDraggingRef.current=false; rightClickRef.current=false; };
    const onCM = (e) => e.preventDefault();
    const onW = (e) => {
      e.preventDefault();
      const mesh=meshRef.current; if(!mesh) return;
      const r=e.deltaY>0?0.95:1.05;
      const ns=transformRef.current.scale*r;
      mesh.scale.setScalar(ns); transformRef.current.scale=ns; setTransform({...transformRef.current});
    };
    const onTS = (e) => {
      if (e.touches.length===1) lastPointerRef.current={x:e.touches[0].clientX,y:e.touches[0].clientY};
      if (e.touches.length===2) {
        const dx=e.touches[1].clientX-e.touches[0].clientX, dy=e.touches[1].clientY-e.touches[0].clientY;
        lastPinchRef.current=Math.hypot(dx,dy); lastTwoFingerAngleRef.current=Math.atan2(dy,dx);
      }
    };
    const onTM = (e) => {
      e.preventDefault();
      const mesh=meshRef.current; if(!mesh) return;
      if (e.touches.length===1) {
        const dx=e.touches[0].clientX-lastPointerRef.current.x, dy=e.touches[0].clientY-lastPointerRef.current.y;
        lastPointerRef.current={x:e.touches[0].clientX,y:e.touches[0].clientY};
        const cam=cameraRef.current;
        const f=(2*Math.tan((cam.fov*Math.PI/180)/2)*cam.position.z)/window.innerHeight;
        mesh.position.x+=dx*f; mesh.position.y-=dy*f;
        transformRef.current.x=mesh.position.x; transformRef.current.y=mesh.position.y;
        setTransform({...transformRef.current});
      } else if (e.touches.length===2) {
        const dx=e.touches[1].clientX-e.touches[0].clientX, dy=e.touches[1].clientY-e.touches[0].clientY;
        const dist=Math.hypot(dx,dy), angle=Math.atan2(dy,dx);
        if (lastPinchRef.current) { const r=dist/lastPinchRef.current; const ns=transformRef.current.scale*r; mesh.scale.setScalar(ns); transformRef.current.scale=ns; }
        if (lastTwoFingerAngleRef.current!==null) { mesh.rotation.y+=angle-lastTwoFingerAngleRef.current; transformRef.current.rotY=mesh.rotation.y; }
        lastPinchRef.current=dist; lastTwoFingerAngleRef.current=angle;
        setTransform({...transformRef.current});
      }
    };
    el.addEventListener("pointerdown",onPD); el.addEventListener("pointermove",onPM);
    el.addEventListener("pointerup",onPU); el.addEventListener("contextmenu",onCM);
    el.addEventListener("wheel",onW,{passive:false});
    el.addEventListener("touchstart",onTS,{passive:false}); el.addEventListener("touchmove",onTM,{passive:false});
    return () => {
      el.removeEventListener("pointerdown",onPD); el.removeEventListener("pointermove",onPM);
      el.removeEventListener("pointerup",onPU); el.removeEventListener("contextmenu",onCM);
      el.removeEventListener("wheel",onW);
      el.removeEventListener("touchstart",onTS); el.removeEventListener("touchmove",onTM);
    };
  }, [step]);

  // ── CAPTURE REFERENCE ──
  function captureReference() {
    if (!cvReady || !window.cv) return;
    const cv = window.cv;
    const video = videoRef.current; if(!video) return;
    const snap = document.createElement("canvas");
    snap.width=video.videoWidth||640; snap.height=video.videoHeight||480;
    snap.getContext("2d").drawImage(video,0,0);
    let src, gray, kps, desc, mask;
    try {
      src=cv.imread(snap); gray=new cv.Mat();
      cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
      const orb=new cv.ORB(500); orbRef.current=orb;
      kps=new cv.KeyPointVector(); desc=new cv.Mat(); mask=new cv.Mat();
      orb.detectAndCompute(gray,mask,kps,desc);
      const count=kps.size();
      if (count<8) {
        setToast({message:"⚠️ Too few features. Try better lighting.",type:"warn"});
        src.delete(); gray.delete(); kps.delete(); desc.delete(); mask.delete(); return;
      }
      refDataRef.current={descriptors:desc, keypoints:kps, transform:{...transformRef.current}};
      setToast({message:`🔒 Lock Acquired — ${count} keypoints`,type:"success"});
      setStep("tracking"); setTrackingState("active");
      src.delete(); gray.delete(); mask.delete();
    } catch(e) {
      console.error("Ref capture error",e);
      try{src?.delete();gray?.delete();kps?.delete();desc?.delete();mask?.delete();}catch{}
      setToast({message:"❌ Failed to capture reference frame.",type:"error"});
    }
  }

  // ── TRACKING LOOP ──
  useEffect(() => {
    if (step!=="tracking") return;
    const cv=window.cv; if(!cv) return;
    let running=true, frameCount=0;
    const video=videoRef.current;
    const trackLoop = () => {
      if(!running) return;
      animFrameRef.current=requestAnimationFrame(trackLoop);
      frameCount++;
      if(frameCount%3!==0) return;
      const ref=refDataRef.current; const orb=orbRef.current;
      if(!ref||!orb||!video||video.readyState<2) return;
      let curGray, curKps, curDesc, mask, matches;
      try {
        const snap=document.createElement("canvas");
        snap.width=video.videoWidth||640; snap.height=video.videoHeight||480;
        snap.getContext("2d").drawImage(video,0,0);
        const src=cv.imread(snap); curGray=new cv.Mat();
        cv.cvtColor(src,curGray,cv.COLOR_RGBA2GRAY); src.delete();
        curKps=new cv.KeyPointVector(); curDesc=new cv.Mat(); mask=new cv.Mat();
        orb.detectAndCompute(curGray,mask,curKps,curDesc);
        curGray.delete(); mask.delete();
        if(curDesc.rows===0){setTrackingState("lost");setMatchCount(0);curKps.delete();curDesc.delete();return;}
        const matcher=new cv.BFMatcher(cv.NORM_HAMMING,false);
        matches=new cv.DMatchVectorVector();
        matcher.knnMatch(ref.descriptors,curDesc,matches,2);
        const good=[];
        for(let i=0;i<matches.size();i++){
          const m=matches.get(i);
          if(m.size()>=2&&m.get(0).distance<0.75*m.get(1).distance)
            good.push({qi:m.get(0).queryIdx,ti:m.get(0).trainIdx});
        }
        matches.delete();
        setMatchCount(good.length);
        if(good.length>=8){
          const sp=[],dp=[];
          for(const g of good){
            const rk=ref.keypoints.get(g.qi); const ck=curKps.get(g.ti);
            sp.push(rk.pt.x,rk.pt.y); dp.push(ck.pt.x,ck.pt.y);
          }
          const sM=cv.matFromArray(good.length,1,cv.CV_32FC2,sp);
          const dM=cv.matFromArray(good.length,1,cv.CV_32FC2,dp);
          const H=cv.findHomography(sM,dM,cv.RANSAC,3.0);
          sM.delete(); dM.delete();
          if(H&&!H.empty()){
            const h=H.data64F;
            const dx=(h[2]-(snap.width/2))/(snap.width/2);
            const dy=-(h[5]-(snap.height/2))/(snap.height/2);
            const sx=Math.sqrt(h[0]*h[0]+h[3]*h[3]);
            const sy=Math.sqrt(h[1]*h[1]+h[4]*h[4]);
            const avgScale=(sx+sy)/2;
            const rotation=Math.atan2(h[3],h[0]);
            const mesh=meshRef.current; const cam=cameraRef.current;
            if(mesh&&cam){
              const fov=2*Math.tan((cam.fov*Math.PI/180)/2)*cam.position.z;
              const bt=ref.transform;
              mesh.position.x=bt.x+dx*fov*0.5;
              mesh.position.y=bt.y+dy*fov*0.5;
              const ns=bt.scale*avgScale;
              if(ns>0.00001&&ns<100) mesh.scale.setScalar(ns);
              mesh.rotation.y=bt.rotY+rotation;
              transformRef.current={...transformRef.current,x:mesh.position.x,y:mesh.position.y,scale:mesh.scale.x,rotY:mesh.rotation.y};
            }
            H.delete();
          }
          setTrackingState("active");
        } else { setTrackingState("lost"); }
        curKps.delete(); curDesc.delete();
      } catch(e) {
        console.error("Tracking error",e);
        try{curGray?.delete();curKps?.delete();curDesc?.delete();mask?.delete();matches?.delete();}catch{}
        setTrackingState("lost");
      }
    };
    trackLoop();
    return () => { running=false; };
  }, [step]);

  function stopTracking() {
    setTrackingState("idle"); setStep("camera");
    if(refDataRef.current){
      try{refDataRef.current.descriptors?.delete();refDataRef.current.keypoints?.delete();}catch{}
      refDataRef.current=null;
    }
  }

  function cleanupAll() {
    cancelAnimationFrame(animFrameRef.current);
    cancelAnimationFrame(previewAnimRef.current);
    streamRef.current?.getTracks().forEach(t=>t.stop());
    rendererOverlayRef.current?.dispose();
    rendererPreviewRef.current?.dispose();
    try{refDataRef.current?.descriptors?.delete();refDataRef.current?.keypoints?.delete();}catch{}
  }

  const onDrop=(e)=>{e.preventDefault();handleFileSelect(e.dataTransfer.files[0]);};

  // ── UPLOAD SCREEN ──
  if (step==="upload") return (
    <div style={{minHeight:"100vh",background:"#0a0a0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"'Courier New',monospace"}}>
      <style>{`
        @keyframes fadeInDown{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        .dz:hover{border-color:#00ff88!important;background:rgba(0,255,136,0.05)!important;}
        .btn-green:hover{background:#00cc6a!important;}
        .btn-green:active{transform:scale(0.97);}
      `}</style>
      {toast && <Toast {...toast} onDone={()=>setToast(null)} />}

      <div style={{marginBottom:40,textAlign:"center"}}>
        <div style={{fontSize:10,letterSpacing:5,color:"#00ff88",marginBottom:8}}>CAD OVERLAY SYSTEM</div>
        <h1 style={{fontSize:26,color:"#fff",margin:0,fontWeight:400,letterSpacing:3}}>
          MODEL ALIGNMENT <span style={{color:"#00ff88"}}>v1.0</span>
        </h1>
        <p style={{color:"#555",fontSize:11,marginTop:8,letterSpacing:1}}>STL → CAMERA → ALIGN → TRACK</p>
      </div>

      <div className="dz" onDrop={onDrop} onDragOver={e=>e.preventDefault()}
        onClick={()=>document.getElementById("stl-input").click()}
        style={{width:"100%",maxWidth:440,border:"1px dashed #333",borderRadius:12,padding:"32px 24px",textAlign:"center",cursor:"pointer",background:"#111",transition:"all 0.2s"}}>
        <input id="stl-input" type="file" accept=".stl" style={{display:"none"}} onChange={e=>handleFileSelect(e.target.files[0])} />

        {!parseInfo ? (
          <>
            <div style={{fontSize:48,marginBottom:12,color:"#00ff88",lineHeight:1}}>⬡</div>
            <div style={{color:"#666",fontSize:13,lineHeight:1.8}}>
              Drop <span style={{color:"#00ff88"}}>.stl</span> file here<br/>
              <span style={{color:"#444",fontSize:11}}>or click to browse</span>
            </div>
            {!threeReady&&(
              <div style={{marginTop:12,fontSize:11,color:"#555"}}>
                <span style={{display:"inline-block",animation:"spin 1s linear infinite",marginRight:6}}>◌</span>
                Loading 3D engine...
              </div>
            )}
          </>
        ):(
          <div onClick={e=>e.stopPropagation()}>
            <canvas ref={previewCanvasRef} width={300} height={300} style={{borderRadius:8,background:"transparent",display:"block",margin:"0 auto 16px"}} />
            <div style={{color:"#fff",fontSize:13,marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{parseInfo.name}</div>
            <div style={{color:"#00ff88",fontSize:11,lineHeight:2}}>
              {parseInfo.triangles.toLocaleString()} triangles
            </div>
            <div style={{color:"#555",fontSize:11}}>{parseInfo.w} × {parseInfo.h} × {parseInfo.d} mm</div>
            <div style={{marginTop:10,fontSize:10,color:"#444",borderTop:"1px solid #222",paddingTop:10}}>
              Click to replace file
            </div>
          </div>
        )}
        {parseError&&<div style={{marginTop:12,color:"#ff4444",fontSize:12}}>{parseError}</div>}
      </div>

      <div style={{marginTop:14,fontSize:11,color:cvReady?"#00ff88":cvError?"#ff6644":"#444",display:"flex",alignItems:"center",gap:6}}>
        {cvReady ? <>✓ CV engine ready</>
          : cvError ? <>⚠ CV engine unavailable — tracking disabled</>
          : <><span style={{display:"inline-block",animation:"spin 1s linear infinite"}}>◌</span> Loading CV engine...</>
        }
      </div>

      {parseInfo&&(
        <button className="btn-green" onClick={startCamera} style={{marginTop:24,padding:"14px 48px",background:"#00ff88",color:"#000",border:"none",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer",letterSpacing:2,fontFamily:"monospace",transition:"all 0.2s"}}>
          OPEN CAMERA →
        </button>
      )}
      {camError&&(
        <div style={{marginTop:16,background:"#1a0000",border:"1px solid #ff4444",borderRadius:8,padding:"12px 16px",maxWidth:440,color:"#ff4444",fontSize:12,lineHeight:1.6}}>
          {camError}
        </div>
      )}
    </div>
  );

  // ── CAMERA/TRACKING SCREEN ──
  const tColor = trackingState==="active"?"#00ff88":trackingState==="lost"?"#ffcc00":"#555";
  const tLabel = trackingState==="active"?`TRACKING — ${matchCount} pts`:trackingState==="lost"?"LOST — Move back to object":"NOT TRACKING";

  return (
    <div style={{position:"relative",width:"100vw",height:"100vh",overflow:"hidden",background:"#000"}}>
      <style>{`
        @keyframes fadeInDown{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}
        @keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 8px #00ff88}50%{opacity:0.5;box-shadow:0 0 20px #00ff88}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes dotPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.4)}}
      `}</style>
      {toast&&<Toast {...toast} onDone={()=>setToast(null)} />}

      {/* VIDEO */}
      <video ref={videoRef} autoPlay playsInline muted style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}} />

      {/* THREE.JS OVERLAY */}
      <canvas ref={overlayCanvasRef} style={{position:"absolute",inset:0,pointerEvents:"none"}} />

      {/* GESTURE LAYER */}
      <div ref={gestureRef} style={{position:"absolute",inset:0,touchAction:"none"}} />

      {/* TOP BAR */}
      <div style={{position:"absolute",top:0,left:0,right:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(10px)",padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",zIndex:10,borderBottom:"1px solid #1a1a1a"}}>
        <div style={{color:"#00ff88",fontSize:10,letterSpacing:4,fontFamily:"monospace"}}>CAD OVERLAY</div>
        <div style={{display:"flex",gap:10,fontSize:10,fontFamily:"monospace",color:"#00ff88"}}>
          {[["X",transform.x.toFixed(2)],["Y",transform.y.toFixed(2)],["S",transform.scale.toFixed(2)],["Rx",(transform.rotX*180/Math.PI).toFixed(0)+"°"],["Ry",(transform.rotY*180/Math.PI).toFixed(0)+"°"],["Rz",(transform.rotZ*180/Math.PI).toFixed(0)+"°"]].map(([k,v])=>(
            <span key={k}><span style={{color:"#444"}}>{k}:</span>{v}</span>
          ))}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div style={{position:"absolute",top:56,right:16,zIndex:10,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
        {/* Tracking indicator */}
        {(step==="tracking")&&(
          <div style={{display:"flex",alignItems:"center",gap:6,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(8px)",borderRadius:8,padding:"6px 12px",border:"1px solid #222"}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:tColor,animation:trackingState==="active"?"dotPulse 1.5s infinite":"none"}} />
            <span style={{fontSize:10,fontFamily:"monospace",color:tColor,letterSpacing:1}}>{tLabel}</span>
          </div>
        )}

        {/* Start/Stop Tracking */}
        {step==="camera"&&(
          <button onClick={captureReference} disabled={!cvReady||cvError} style={{
            padding:"12px 16px",borderRadius:8,minWidth:160,
            background:cvReady?"rgba(0,255,136,0.12)":"rgba(255,255,255,0.04)",
            border:`1px solid ${cvReady?"#00ff88":"#333"}`,
            color:cvReady?"#00ff88":"#555",fontSize:11,fontFamily:"monospace",letterSpacing:1,
            cursor:cvReady?"pointer":"not-allowed",
            animation:cvReady?"pulse 2s infinite":"none"
          }}>
            {!cvReady&&!cvError?<><span style={{animation:"spin 1s linear infinite",display:"inline-block",marginRight:6}}>◌</span>LOADING CV...</>
              :cvError?"CV UNAVAILABLE":"▶  START TRACKING"}
          </button>
        )}
        {step==="tracking"&&(
          <button onClick={stopTracking} style={{
            padding:"12px 16px",borderRadius:8,minWidth:160,
            background:"rgba(255,68,68,0.12)",border:"1px solid #ff4444",
            color:"#ff4444",fontSize:11,fontFamily:"monospace",letterSpacing:1,cursor:"pointer"
          }}>■  STOP TRACKING</button>
        )}

        {/* Back */}
        <button onClick={()=>{cleanupAll();setStep("upload");setParseInfo(null);setTrackingState("idle");}} style={{
          padding:"8px 14px",borderRadius:8,background:"rgba(255,255,255,0.04)",
          border:"1px solid #2a2a2a",color:"#555",fontSize:10,fontFamily:"monospace",cursor:"pointer"
        }}>← BACK</button>
      </div>

      {/* CONTROLS HINT */}
      <div style={{position:"absolute",bottom:24,left:16,zIndex:10,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(8px)",borderRadius:10,padding:"12px 14px",border:"1px solid #1e1e1e"}}>
        <div style={{fontSize:9,color:"#00ff88",letterSpacing:3,marginBottom:8,fontFamily:"monospace"}}>CONTROLS</div>
        {[["👆","Drag","Move XY"],["🤏","Pinch","Scale"],["✌️","2-finger","Rotate Y"],["🖱️","Scroll","Scale"],["⇧+R","Right-drag","Rotate X"],["⌃+R","Right-drag","Rotate Z"]].map(([ic,k,v])=>(
          <div key={k} style={{display:"flex",gap:6,marginBottom:3,alignItems:"center"}}>
            <span style={{fontSize:11,width:22}}>{ic}</span>
            <span style={{fontSize:10,color:"#444",fontFamily:"monospace",width:48}}>{k}</span>
            <span style={{fontSize:10,color:"#888",fontFamily:"monospace"}}>{v}</span>
          </div>
        ))}
      </div>

      {/* TRACKING LOST OVERLAY */}
      {step==="tracking"&&trackingState==="lost"&&(
        <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",zIndex:10,background:"rgba(0,0,0,0.85)",border:"1px solid #ffcc00",borderRadius:10,padding:"20px 28px",textAlign:"center"}}>
          <div style={{fontSize:24,marginBottom:8}}>⚠️</div>
          <div style={{color:"#ffcc00",fontFamily:"monospace",fontSize:13,letterSpacing:2,fontWeight:700}}>TRACKING LOST</div>
          <div style={{color:"#666",fontSize:11,marginTop:6,fontFamily:"monospace"}}>Move camera back to object</div>
        </div>
      )}
    </div>
  );
}
