const phase4Rows = [
  ["geometric-optics-basics", "几何光学：基础（英文界面）", "移动物体和透镜，观察焦点、光线路径与成像变化。", "physics", ["light-radiation"], ["primary", "middle", "high"]],
  ["greenhouse-effect", "温室效应（英文界面）", "观察太阳辐射、大气和温室气体对地球温度的影响。", "earth-science", [], ["primary", "middle", "high"]],
  ["magnet-and-compass", "磁铁与指南针（英文界面）", "移动磁铁和指南针，观察磁场方向与相互作用。", "physics", ["electricity-magnetism-circuits"], ["primary", "middle", "high"]],
  ["magnets-and-electromagnets", "磁铁与电磁铁（英文界面）", "改变线圈和电流，比较永久磁铁与电磁铁的磁场。", "physics", ["electricity-magnetism-circuits"], ["primary", "middle", "high"]],
  ["my-solar-system", "我的太阳系（英文界面）", "设置天体质量、位置和速度，观察引力作用下的轨道。", "earth-science", [], ["primary", "middle", "high"]],
  ["buoyancy-basics", "浮力：基础（英文界面）", "改变物体质量、体积和液体密度，观察浮沉与浮力。", "physics", ["motion"], ["middle", "high"]],
  ["faradays-electromagnetic-lab", "法拉第电磁实验室（英文界面）", "用磁铁、线圈和电流计探索电磁感应。", "physics", ["electricity-magnetism-circuits"], ["middle", "high"]],
  ["generator", "发电机（英文界面）", "转动磁铁和线圈，观察机械能转化为电能。", "physics", ["electricity-magnetism-circuits", "work-energy-power"], ["middle", "high"]],
  ["membrane-transport", "细胞膜运输（英文界面）", "观察粒子通过细胞膜的扩散、通道与主动运输。", "biology", [], ["middle", "high"]],
  ["models-of-the-hydrogen-atom", "氢原子模型（英文界面）", "比较不同原子模型如何解释氢原子光谱。", "physics", ["quantum-phenomena", "light-radiation"], ["middle", "high"]],
  ["sound-waves", "声波（英文界面）", "改变声源频率和振幅，观察空气粒子运动与声波传播。", "physics", ["waves"], ["middle", "high"]],
  ["build-a-nucleus", "构建原子核（英文界面）", "组合质子和中子，观察原子核稳定性及核素变化。", "physics", ["quantum-phenomena"], ["high"]],
  ["buoyancy", "浮力（英文界面）", "定量研究重力、浮力、密度和排开液体体积。", "physics", ["motion"], ["high"]],
  ["keplers-laws", "开普勒定律（英文界面）", "改变轨道参数，探索行星运动与开普勒三定律。", "earth-science", [], ["high"]],
  ["normal-modes", "简正模式（英文界面）", "激发耦合振动系统，观察驻波和不同振动模式。", "physics", ["waves"], ["high"]],
  ["projectile-data-lab", "抛体数据实验室（英文界面）", "收集抛体运动数据并分析变量、图像和模型。", "physics", ["motion"], ["high"]],
];

export const phetPhase4Simulations = phase4Rows.map(
  ([id, title, description, subject, topics, stages]) => ({
    id,
    title,
    description,
    subject,
    topics,
    stages,
    localUrl: `/simulations/phet/${id}.html`,
    originalUrl: `https://phet.colorado.edu/en/simulations/${id}`,
    sourceUrl: `https://phet.colorado.edu/sims/html/${id}/latest/${id}_en.html`,
    batch: "phase4",
    available: true,
  }),
);
