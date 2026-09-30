"""Held-out lecture 1 (HTML slides printed by Chromium): python3 make_heldout1.py && node print-heldout.mjs"""
import base64, os
import images
HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "img")
os.makedirs(IMG, exist_ok=True)
images.histology("arterial_thrombus.jpg", 201, base=(200, 90, 110), nuclei=(240, 220, 225), density=300)
images.histology("venous_thrombus.jpg", 202, base=(150, 20, 40), nuclei=(90, 10, 20), density=500, big=True)
images.gross("pale_infarct.jpg", 203, [(235, 225, 200), (220, 210, 190)], bg=(120, 40, 50), shape="organ")
images.gross("red_infarct.jpg", 204, [(130, 20, 30), (160, 40, 50)], bg=(40, 40, 40), shape="lung")
def b64(n): return "data:image/jpeg;base64," + base64.b64encode(open(os.path.join(IMG, n), "rb").read()).decode()
css = """@page { size: 13.333in 7.5in; margin: 0 } body { margin:0; font-family: 'DejaVu Sans', sans-serif; }
.s { width: 13.333in; height: 7.5in; box-sizing: border-box; padding: 0.5in 0.7in; page-break-after: always; position: relative }
h1 { font-size: 34pt; margin: 0 0 0.3in 0; color: #123 } p { font-size: 18pt; line-height: 1.3; margin: 0 0 0.15in 0 }
.cols { display: flex; gap: 0.6in } .cols > div { flex: 1 } h2 { font-size: 20pt; margin: 0 0 0.1in 0 }
li { font-size: 18pt; margin-bottom: 0.06in } table { border-collapse: collapse; font-size: 16pt; width: 100% } td, th { border: 1px solid #333; padding: 6px 10px; text-align: left }
figure { margin: 0; } figcaption { font-size: 13pt; color: #333 } img { width: 100% }"""
S = []
S.append("<div class='s'><h1 style='margin-top:2in;text-align:center'>Hemodynamic Disorders and Diuretics</h1><p style='text-align:center'>Integrated Block 2 — Session 14<br>Prof. L. Rahman</p></div>")
S.append("""<div class='s'><h1>Edema</h1><p>Edema is an accumulation of interstitial fluid within tissues. It results from increased hydrostatic pressure, reduced plasma oncotic pressure, lymphatic obstruction or sodium retention.</p>
<p>Congestive heart failure is the most common cause of increased hydrostatic pressure. Nephrotic syndrome causes edema through loss of albumin in the urine.</p></div>""")
S.append("""<div class='s'><h1>Virchow triad</h1><p>Three factors predispose to thrombosis:</p><ol><li>Endothelial injury</li><li>Abnormal blood flow (stasis or turbulence)</li><li>Hypercoagulability</li></ol>
<p>Endothelial injury is the dominant influence in the heart and arterial circulation. Stasis is the major factor in the development of venous thrombi.</p></div>""")
S.append(f"""<div class='s'><h1>Arterial and venous thrombi</h1><div class='cols'>
<figure><figcaption>Figure 4: Arterial thrombus with lines of Zahn</figcaption><img src='{b64("arterial_thrombus.jpg")}'></figure>
<figure><figcaption>Figure 5: Venous thrombus (phlebothrombosis)</figcaption><img src='{b64("venous_thrombus.jpg")}'></figure></div>
<p style='margin-top:0.2in'>Arterial thrombi usually begin at sites of endothelial injury. Venous thrombi almost invariably occlude the lumen. They most commonly involve the veins of the lower extremities.</p></div>""")
S.append("""<div class='s'><h1>Embolism</h1><div class='cols'><div><h2>Pulmonary embolism</h2><p>More than 95% of pulmonary emboli originate from deep vein thrombi of the legs. A large embolus lodged at the bifurcation of the pulmonary artery is called a saddle embolus.</p></div>
<div><h2>Fat embolism</h2><p>Fat embolism usually follows fractures of long bones. It causes pulmonary insufficiency, neurologic symptoms, anemia and thrombocytopenia.</p></div></div></div>""")
S.append(f"""<div class='s'><h1>Infarction</h1><div class='cols'><figure><img src='{b64("pale_infarct.jpg")}'><figcaption>White infarct of the spleen</figcaption></figure>
<figure><img src='{b64("red_infarct.jpg")}'><figcaption>Red infarct of the lung</figcaption></figure></div>
<p style='margin-top:0.15in'>White infarcts occur with arterial occlusions in solid organs with end-arterial circulation. Red infarcts occur in tissues with a dual blood supply, such as the lung.</p></div>""")
S.append("""<div class='s'><h1>Shock</h1><table><tr><th>Type of shock</th><th>Mechanism</th><th>Clinical example</th></tr>
<tr><td>Cardiogenic</td><td>Myocardial pump failure</td><td>Myocardial infarction</td></tr>
<tr><td>Hypovolemic</td><td>Loss of blood or plasma volume</td><td>Hemorrhage</td></tr>
<tr><td>Septic</td><td>Peripheral vasodilation and pooling of blood</td><td>Gram-negative infection</td></tr></table>
<p style='margin-top:0.3in'>Why does septic shock cause warm, flushed skin?</p></div>""")
S.append("""<div class='s'><h1>Loop and thiazide diuretics</h1><div class='cols'><div><h2>Furosemide</h2><p>Furosemide inhibits the Na-K-2Cl cotransporter in the thick ascending limb of the loop of Henle. It is used to treat acute pulmonary edema. It can cause hypokalemia and ototoxicity.</p></div>
<div><h2>Hydrochlorothiazide</h2><p>Hydrochlorothiazide inhibits the NaCl cotransporter in the distal convoluted tubule. It is used to treat hypertension. It decreases urinary calcium excretion.</p></div></div></div>""")
S.append("""<div class='s'><h1>Potassium-sparing diuretics</h1><ul><li>Spironolactone is a competitive aldosterone receptor antagonist.</li><li>It is used in primary hyperaldosteronism and heart failure.</li><li>Amiloride blocks epithelial sodium channels in the collecting duct.</li><li>Both drugs can cause hyperkalemia.</li></ul>
<table style='margin-top:0.2in'><tr><th>Diuretic</th><th>Site of action</th></tr><tr><td>Acetazolamide</td><td>Proximal convoluted tubule</td></tr><tr><td>Mannitol</td><td>Proximal tubule and descending limb</td></tr><tr><td>Furosemide</td><td>Thick ascending limb</td></tr></table></div>""")
S.append("<div class='s'><h1>Summary and questions</h1><ul><li>Thrombosis → embolism → infarction</li><li>Know your diuretics!</li></ul><p>Any questions?</p></div>")
open(os.path.join(HERE, "heldout.html"), "w").write(f"<html><head><meta charset='utf-8'><style>{css}</style></head><body>{''.join(S)}</body></html>")
